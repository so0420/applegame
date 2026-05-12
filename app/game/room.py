"""Room and Player models."""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from .board import generate_board, ROWS, COLS, TOTAL

GAME_DURATION = 120.0  # seconds

# Item-mode constants
INVENTORY_SIZE = 3
ATTACK_LOCKOUT = 10.0           # seconds before game end where attacks are blocked
EFFECT_DOUBLE = 8.0             # 2× score duration
EFFECT_BLIND = 3.0              # number-hide duration
EFFECT_HINT = 3.0               # hint highlight duration
ITEM_KINDS = ("hint", "double", "blind", "shuffle")
# Golden apples: a fixed number of apples are marked golden at game
# start (same positions for every player). Clearing one grants a
# random item into a free inventory slot; no respawn over time.
INITIAL_GOLDEN_COUNT = 3
# Three independent item-drop triggers (golden, big-clear, combo).
# If a single submit satisfies more than one trigger the player still
# only receives a single item — the simultaneous-trigger cap.
COMBO_THRESHOLD = 3
COMBO_WINDOW_S = 0.3
BIG_CLEAR_CELLS = 4


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
    double_until: float = 0.0       # score-multiplier deadline (epoch s)
    blind_until: float = 0.0        # number-hide deadline imposed on me
    combo_count: int = 0            # consecutive-clear streak (within window)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "score": self.score,
            "connected": self.connected,
            "inventory": list(self.inventory),
            "combo": self.combo_count,
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
            p.double_until = 0.0
            p.blind_until = 0.0
            p.combo_count = 0

    def start(self) -> None:
        self._init_boards()
        self.state = "playing"
        self.started_at = time.time()
        self.ends_at = self.started_at + GAME_DURATION
        for p in self.players.values():
            p.score = 0
            p.last_score_ts = 0.0
            p.inventory = [None] * INVENTORY_SIZE
            p.double_until = 0.0
            p.blind_until = 0.0
            p.combo_count = 0

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
