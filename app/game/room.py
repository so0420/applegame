"""Room and Player models."""
from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from .board import generate_board, ROWS, COLS, TOTAL

GAME_DURATION = 120.0  # seconds
# 3-2-1 countdown before input is accepted at round start. The board is
# revealed during the countdown so players can scout, but SUBMIT and
# USE_ITEM are gated server-side until started_at.
COUNTDOWN_SECS = 3.0

# Item-mode constants
INVENTORY_SIZE = 3
ATTACK_LOCKOUT = 10.0           # seconds before game end where attacks are blocked
EFFECT_BLIND = 3.0              # number-hide duration
EFFECT_HINT = 3.0               # hint highlight duration
EFFECT_SHIELD = 8.0             # incoming-attack immunity duration
EFFECT_OVERLOAD = 3.0           # displayed-number deception duration
EFFECT_FREEZE = 2.0             # input-lock duration
ITEM_KINDS = ("hint", "shuffle", "blind", "overload", "freeze", "shield")
# Rank-tier weighted drops: lower-ranked players get more self-help
# (hint, self-shuffle), mid-tier gets attacks (blind/overload/freeze),
# top-tier gets defense (shield) and board-reset utility. Solo /
# single-player rooms fall back to "middle". Weights are integers; each
# tier intentionally sums to 20 so the help screen shows clean 5% steps.
# NOTE: keep in sync with ITEM_DROP_WEIGHTS in static/js/main.js (the help
# screen renders percentages from the JS mirror).
ITEM_DROP_WEIGHTS: dict[str, dict[str, int]] = {
    "top":    {"hint": 2, "shuffle": 4, "blind": 2, "overload": 2, "freeze": 1, "shield": 9},
    "middle": {"hint": 2, "shuffle": 3, "blind": 5, "overload": 5, "freeze": 3, "shield": 2},
    "bottom": {"hint": 6, "shuffle": 5, "blind": 3, "overload": 2, "freeze": 2, "shield": 2},
}
# Golden apples: a fixed number of apples are marked golden at game
# start (same positions for every player). Clearing one grants a
# random item into a free inventory slot; no respawn over time.
INITIAL_GOLDEN_COUNT = 3
# Three independent item-drop triggers (golden, big-clear, combo).
# If a single submit satisfies more than one trigger the player still
# only receives a single item — the simultaneous-trigger cap.
COMBO_THRESHOLD = 5
COMBO_WINDOW_S = 2.0
BIG_CLEAR_CELLS = 4
# Anti-macro: every successful SUBMIT must satisfy these rate caps.
# Drag-context checks are intentionally not part of this gate — they
# had too many false-positive rejections from fast legitimate play
# (throttled drag_update + tight window). The rate limits below plus
# the client-side isTrusted gate and the WebSocket tamper detection
# already cover the realistic bot patterns.
MIN_SUBMIT_GAP_S = 0.05         # 50ms — 20 clears/s instantaneous ceiling
MAX_SUBMITS_PER_1S = 4          # ≥4 valid clears in 1s = reject 5th+
MAX_SUBMITS_PER_3S = 12         # 3× of the per-second cap


@dataclass
class Player:
    id: str
    nickname: str
    ws: WebSocket | None = None
    score: int = 0
    last_drag: tuple[int, int, int, int] | None = None
    last_score_ts: float = 0.0
    connected: bool = True
    # Item-mode state (unused in classic variant)
    inventory: list[str | None] = field(
        default_factory=lambda: [None] * INVENTORY_SIZE
    )
    blind_until: float = 0.0        # number-hide deadline imposed on me
    shield_until: float = 0.0       # incoming-attack immunity deadline
    overload_until: float = 0.0     # displayed-number deception deadline
    freeze_until: float = 0.0       # input-lock deadline imposed on me
    combo_count: int = 0            # consecutive-clear streak (within window)
    # Anti-macro state (server-side; not exposed to the client)
    submit_history: deque[float] = field(default_factory=lambda: deque(maxlen=64))
    # Medals earned in this room across rounds (friend mode only).
    # Reset implicitly when the player leaves and the Player object is dropped.
    medals: dict[str, int] = field(
        default_factory=lambda: {"gold": 0, "silver": 0, "bronze": 0}
    )

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "score": self.score,
            "connected": self.connected,
            "inventory": list(self.inventory),
            "combo": self.combo_count,
            "medals": dict(self.medals),
        }


RoomMode = Literal["solo", "friend", "random"]
RoomState = Literal["waiting", "playing", "finished"]
RoomVariant = Literal["classic", "items"]


CAPACITY_MIN = 2
CAPACITY_MAX = 50
CAPACITY_DEFAULT = 10


@dataclass
class Room:
    id: str
    mode: RoomMode
    capacity: int = 2
    host_id: str | None = None
    players: dict[str, Player] = field(default_factory=dict)
    boards: dict[str, list[list[int]]] = field(default_factory=dict)
    initial_board: list[list[int]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    state: RoomState = "waiting"
    started_at: float | None = None
    ends_at: float | None = None
    apples_left: dict[str, int] = field(default_factory=dict)
    winner_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None
    # Item-mode state
    variant: RoomVariant = "classic"
    # Shared list of (r, c) cells flagged golden at game start. Same for
    # every player so the strategic landmarks are equal.
    initial_golden: list[tuple[int, int]] = field(default_factory=list)
    # Per-player live set of remaining (i.e. not yet cleared) golden cells.
    golden: dict[str, set[tuple[int, int]]] = field(default_factory=dict)

    @property
    def is_full(self) -> bool:
        return len(self.players) >= self.capacity

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode,
            "variant": self.variant,
            "host_id": self.host_id,
            "state": self.state,
            "capacity": self.capacity,
            "players": [p.public() for p in self.players.values()],
            "ends_at": self.ends_at,
        }

    def reset_for_rematch(self) -> None:
        self._init_boards()
        self.state = "waiting"
        self.started_at = None
        self.ends_at = None
        self.winner_id = None
        for p in self.players.values():
            p.score = 0
            p.last_drag = None
            p.last_score_ts = 0.0
            p.inventory = [None] * INVENTORY_SIZE
            p.blind_until = 0.0
            p.shield_until = 0.0
            p.overload_until = 0.0
            p.freeze_until = 0.0
            p.combo_count = 0
            p.submit_history.clear()

    def start(self) -> None:
        # Read the module-level constant fresh so tests can monkeypatch it.
        import app.game.room as _room_mod
        countdown = _room_mod.COUNTDOWN_SECS
        self._init_boards()
        self.state = "playing"
        # started_at is the moment inputs become live, i.e. countdown end.
        self.started_at = time.time() + countdown
        self.ends_at = self.started_at + GAME_DURATION
        for p in self.players.values():
            p.score = 0
            p.last_score_ts = 0.0
            p.inventory = [None] * INVENTORY_SIZE
            p.blind_until = 0.0
            p.shield_until = 0.0
            p.overload_until = 0.0
            p.freeze_until = 0.0
            p.combo_count = 0
            p.submit_history.clear()

    def _init_boards(self) -> None:
        """Generate one master board, deep-copy per player."""
        master = generate_board()
        self.initial_board = [row[:] for row in master]
        self.boards = {pid: [row[:] for row in master] for pid in self.players}
        self.apples_left = {pid: TOTAL for pid in self.players}
        # Pick a shared set of golden cells (only used in items variant,
        # but we always pick so reconnect / rematch paths stay simple).
        all_cells = [(r, c) for r in range(ROWS) for c in range(COLS)]
        picks = random.sample(all_cells, k=INITIAL_GOLDEN_COUNT)
        self.initial_golden = picks
        self.golden = {pid: set(picks) for pid in self.players}
        self.events = []

    def determine_winner(self) -> str | None:
        if not self.players:
            return None
        scored = sorted(
            self.players.values(),
            key=lambda p: (-p.score, p.last_score_ts or float("inf")),
        )
        top = scored[0]
        # Tie: same score and same/zero score timestamp → no winner
        if len(scored) > 1 and scored[0].score == scored[1].score:
            if scored[0].last_score_ts == scored[1].last_score_ts:
                return None
        return top.id
