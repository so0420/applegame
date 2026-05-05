"""Room and Player models."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from .board import generate_board, ROWS, COLS, TOTAL

GAME_DURATION = 120.0  # seconds


@dataclass
class Player:
    id: str
    nickname: str
    ws: WebSocket | None = None
    score: int = 0
    last_drag: tuple[int, int, int, int] | None = None
    last_score_ts: float = 0.0
    connected: bool = True

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "score": self.score,
            "connected": self.connected,
        }


RoomMode = Literal["solo", "friend", "random"]
RoomState = Literal["waiting", "playing", "finished"]


@dataclass
class Room:
    id: str
    mode: RoomMode
    host_id: str | None = None
    players: dict[str, Player] = field(default_factory=dict)
    boards: dict[str, list[list[int]]] = field(default_factory=dict)
    state: RoomState = "waiting"
    started_at: float | None = None
    ends_at: float | None = None
    apples_left: dict[str, int] = field(default_factory=dict)
    winner_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer_task: asyncio.Task | None = None

    @property
    def capacity(self) -> int:
        return 1 if self.mode == "solo" else 2

    @property
    def is_full(self) -> bool:
        return len(self.players) >= self.capacity

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode,
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

    def start(self) -> None:
        self._init_boards()
        self.state = "playing"
        self.started_at = time.time()
        self.ends_at = self.started_at + GAME_DURATION
        for p in self.players.values():
            p.score = 0
            p.last_score_ts = 0.0

    def _init_boards(self) -> None:
        """Generate one master board, deep-copy per player."""
        master = generate_board()
        self.boards = {pid: [row[:] for row in master] for pid in self.players}
        self.apples_left = {pid: TOTAL for pid in self.players}

    def initial_board(self) -> list[list[int]]:
        """Master starting state, sent in game_start. All players begin here."""
        if not self.boards:
            return []
        return next(iter(self.boards.values()))

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
