"""Room and Player models."""
from __future__ import annotations

import asyncio
import random
import time
import uuid
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
# Team mode: two players share one board, so the inventory is a shared
# team pool with more slots. Min players to start a team round (2 teams).
TEAM_INVENTORY_SIZE = 4
TEAM_MIN_PLAYERS = 4
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
#
# Balance notes (2026-06):
#   - shuffle is strong, so it's heavily skewed to the bottom tier and made
#     nearly absent at the top (top 5% / mid 15% / bottom 30%).
#   - shield was over-dropping at the top (was 45%), letting leaders wall off
#     every attack. Cut to 30% so attacks land more often while shield is
#     still the single most likely top-tier drop.
ITEM_DROP_WEIGHTS: dict[str, dict[str, int]] = {
    "top":    {"hint": 4, "shuffle": 1, "blind": 4, "overload": 3, "freeze": 2, "shield": 6},
    "middle": {"hint": 3, "shuffle": 3, "blind": 5, "overload": 4, "freeze": 3, "shield": 2},
    "bottom": {"hint": 7, "shuffle": 6, "blind": 2, "overload": 2, "freeze": 2, "shield": 1},
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
# Drought relief: a player who goes this long without clearing a single
# apple is handed one tier-weighted item (catch-up for whoever is stuck —
# a dead board, an attack lockdown, or simply falling behind). Resets the
# moment they clear again or receive a relief item.
DROUGHT_SECONDS = 15.0
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
    # AI partner (team mode, odd player count). Has no ws; never counts as a
    # real connection for cleanup; cannot use items.
    is_bot: bool = False
    # Item-mode state (unused in classic variant)
    inventory: list[str | None] = field(
        default_factory=lambda: [None] * INVENTORY_SIZE
    )
    blind_until: float = 0.0        # number-hide deadline imposed on me
    shield_until: float = 0.0       # incoming-attack immunity deadline
    overload_until: float = 0.0     # displayed-number deception deadline
    freeze_until: float = 0.0       # input-lock deadline imposed on me
    combo_count: int = 0            # consecutive-clear streak (within window)
    # Drought relief anchor: the timestamp we measure "time since last
    # clear" against. Set to started_at at round start, bumped on every
    # clear and on every relief grant. Separate from last_score_ts so the
    # relief clock never perturbs combo / tiebreak logic.
    drought_anchor: float = 0.0
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
            "is_bot": self.is_bot,
        }


def make_bot_player() -> "Player":
    """An AI partner for an odd-one-out human in team mode."""
    return Player(
        id="bot-" + uuid.uuid4().hex[:10],
        nickname="🤖 AI 봇",
        ws=None,
        is_bot=True,
        connected=True,
    )


@dataclass
class Team:
    """A team-mode unit: 1-2 players (one may be a bot) sharing one board.

    Duck-types the item-state fields of Player so the game engine can treat
    a Team as the 'actor' (board owner) uniformly — board/score/inventory/
    effects/combo all live here, keyed by the team id."""
    id: str
    members: list["Player"] = field(default_factory=list)
    score: int = 0
    last_score_ts: float = 0.0
    inventory: list[str | None] = field(
        default_factory=lambda: [None] * TEAM_INVENTORY_SIZE
    )
    blind_until: float = 0.0
    shield_until: float = 0.0
    overload_until: float = 0.0
    freeze_until: float = 0.0
    combo_count: int = 0
    drought_anchor: float = 0.0

    @property
    def connected(self) -> bool:
        # A team is "live" while at least one human controller is connected.
        return any(m.connected for m in self.members if not m.is_bot)

    def human_members(self) -> list["Player"]:
        return [m for m in self.members if not m.is_bot]

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "members": [
                {"id": m.id, "nickname": m.nickname, "is_bot": m.is_bot}
                for m in self.members
            ],
            "score": self.score,
            "inventory": list(self.inventory),
            "combo": self.combo_count,
        }


RoomMode = Literal["solo", "friend", "random"]
RoomState = Literal["waiting", "playing", "finished"]
RoomVariant = Literal["classic", "items", "team"]


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
    drought_task: asyncio.Task | None = None
    # AI partner loops (team mode); cancelled at round end / room teardown.
    bot_tasks: list[asyncio.Task] = field(default_factory=list)
    # Spectators: connections watching a friend room that's already playing /
    # finished (e.g. someone who clicked an invite link mid-round). They get
    # broadcasts and a state snapshot but are NOT game players — no board,
    # no score, no leaderboard slot. Promoted to real players when the room
    # returns to the lobby for the next round.
    spectators: dict[str, Player] = field(default_factory=dict)
    # Player ids the host kicked from this room. Blocks rejoin-by-code so a
    # kicked player can't immediately walk back in. Persists across rounds.
    banned: set[str] = field(default_factory=set)
    # Item-mode state
    variant: RoomVariant = "classic"
    # Shared list of (r, c) cells flagged golden at game start. Same for
    # every player so the strategic landmarks are equal.
    initial_golden: list[tuple[int, int]] = field(default_factory=list)
    # Per-owner live set of remaining (i.e. not yet cleared) golden cells.
    golden: dict[str, set[tuple[int, int]]] = field(default_factory=dict)
    # Team mode: teams keyed by team id, plus a player_id -> team_id lookup.
    # Empty in non-team variants and while a team room sits in the lobby.
    teams: dict[str, "Team"] = field(default_factory=dict)
    team_of: dict[str, str] = field(default_factory=dict)

    @property
    def is_full(self) -> bool:
        # Bots never count toward capacity (they're added at round start).
        return sum(1 for p in self.players.values() if not p.is_bot) >= self.capacity

    def public(self) -> dict[str, Any]:
        data = {
            "id": self.id,
            "mode": self.mode,
            "variant": self.variant,
            "host_id": self.host_id,
            "state": self.state,
            "capacity": self.capacity,
            # Lobby roster shows only real players (bots appear at round start
            # inside their team).
            "players": [p.public() for p in self.players.values() if not p.is_bot],
            "ends_at": self.ends_at,
        }
        if self.variant == "team":
            data["teams"] = [t.public() for t in self.teams.values()]
        return data

    # ---- Owner/actor abstraction --------------------------------------
    # The "owner" of a board/score is a Team in team mode, else the Player.
    # Engine code operates on actors() / actor_for() so non-team paths stay
    # byte-for-byte identical (owner == player there).
    def _owner_ids(self) -> list[str]:
        if self.variant == "team":
            return list(self.teams.keys())
        return list(self.players.keys())

    def actors(self) -> list[Any]:
        if self.variant == "team":
            return list(self.teams.values())
        return list(self.players.values())

    def actor_for(self, player_id: str) -> Any:
        if self.variant == "team":
            tid = self.team_of.get(player_id)
            return self.teams.get(tid) if tid is not None else None
        return self.players.get(player_id)

    def _form_teams(self) -> None:
        """Randomly pair humans into teams of 2; an odd one out gets a bot.
        Re-forms from scratch each round."""
        # Drop any bots left over from a previous round.
        self.players = {pid: p for pid, p in self.players.items() if not p.is_bot}
        humans = [p for p in self.players.values() if not p.is_bot]
        order = humans[:]
        random.shuffle(order)
        self.teams = {}
        self.team_of = {}
        i = 0
        idx = 1
        while i < len(order):
            members = [order[i]]
            if i + 1 < len(order):
                members.append(order[i + 1])
                i += 2
            else:
                bot = make_bot_player()
                self.players[bot.id] = bot
                members.append(bot)
                i += 1
            tid = f"T{idx}"
            idx += 1
            self.teams[tid] = Team(id=tid, members=members)
            for m in members:
                self.team_of[m.id] = tid

    def _disband_teams(self) -> None:
        """Tear down teams + drop bots (used when returning to the lobby)."""
        self.players = {pid: p for pid, p in self.players.items() if not p.is_bot}
        self.teams = {}
        self.team_of = {}

    def reset_for_rematch(self) -> None:
        if self.variant == "team":
            self._disband_teams()
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
            p.drought_anchor = 0.0
            p.submit_history.clear()

    def start(self) -> None:
        # Read the module-level constant fresh so tests can monkeypatch it.
        import app.game.room as _room_mod
        countdown = _room_mod.COUNTDOWN_SECS
        if self.variant == "team":
            self._form_teams()
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
            p.drought_anchor = self.started_at or 0.0
            p.last_drag = None
            p.submit_history.clear()
        # Team item-state lives on the Team; freshly formed teams start clean,
        # so only the drought clock needs anchoring to round start.
        for t in self.teams.values():
            t.drought_anchor = self.started_at or 0.0

    def _init_boards(self) -> None:
        """Generate one master board, deep-copy per board owner (team in team
        mode, else player)."""
        master = generate_board()
        self.initial_board = [row[:] for row in master]
        owner_ids = self._owner_ids()
        self.boards = {oid: [row[:] for row in master] for oid in owner_ids}
        self.apples_left = {oid: TOTAL for oid in owner_ids}
        # Pick a shared set of golden cells (only used in items/team variants,
        # but we always pick so reconnect / rematch paths stay simple).
        all_cells = [(r, c) for r in range(ROWS) for c in range(COLS)]
        picks = random.sample(all_cells, k=INITIAL_GOLDEN_COUNT)
        self.initial_golden = picks
        self.golden = {oid: set(picks) for oid in owner_ids}
        self.events = []

    def determine_winner(self) -> str | None:
        # Over actors: teams in team mode (returns a team id), else players.
        actors = self.actors()
        if not actors:
            return None
        scored = sorted(
            actors,
            key=lambda a: (-a.score, a.last_score_ts or float("inf")),
        )
        top = scored[0]
        # Tie: same score and same/zero score timestamp → no winner
        if len(scored) > 1 and scored[0].score == scored[1].score:
            if scored[0].last_score_ts == scored[1].last_score_ts:
                return None
        return top.id
