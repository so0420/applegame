"""Random matchmaking — single growing waiting room with countdown.

Players joining 'random' all land in the same pending room (capacity 16).
The countdown starts when 2 players are present (30 s) and short-circuits
to 3 s when the room hits 16. When the timer fires the room is started.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Awaitable, Callable

from . import schemas as S
from .game.room import Player, Room

if TYPE_CHECKING:
    from .ws.manager import RoomManager

log = logging.getLogger(__name__)


class Matchmaker:
    MIN_PLAYERS = 2
    MAX_PLAYERS = 16
    WAIT_AFTER_PAIR = 30.0     # seconds after 2nd player joins
    WAIT_WHEN_FULL = 3.0       # seconds once we hit MAX_PLAYERS

    def __init__(
        self,
        manager: "RoomManager",
        on_start: Callable[[Room], Awaitable[None]],
        broadcast: Callable[..., Awaitable[None]],
    ) -> None:
        self.manager = manager
        self._on_start = on_start
        self._broadcast = broadcast
        self._pending_id: str | None = None
        self._countdown_task: asyncio.Task | None = None
        self._deadline_ms: int | None = None
        self._lock = asyncio.Lock()

    @property
    def deadline_ms(self) -> int | None:
        return self._deadline_ms

    async def enqueue(self, player: Player) -> tuple[Room, int | None]:
        """Add player to the current pending room (creating one if needed).
        Returns (room, deadline_ms) — deadline_ms is None if no countdown
        is running yet.
        """
        async with self._lock:
            room = self._current_pending_room()
            if room is None:
                room = await self.manager.create_room(
                    "random", player, capacity=self.MAX_PLAYERS,
                )
                self._pending_id = room.id
            else:
                async with room.lock:
                    room.players[player.id] = player

            count = len(room.players)
            if count >= self.MAX_PLAYERS:
                self._reschedule_locked(room, self.WAIT_WHEN_FULL)
            elif count >= self.MIN_PLAYERS and self._is_idle():
                self._reschedule_locked(room, self.WAIT_AFTER_PAIR)
            return room, self._deadline_ms

    async def player_left(self, player_id: str, room: Room) -> None:
        """A player left a pending random room. Cancel countdown if we drop
        below MIN_PLAYERS, drop the room entirely if it's empty.
        """
        async with self._lock:
            if self._pending_id != room.id:
                return  # not our pending room
            future_count = len(room.players) - (1 if player_id in room.players else 0)
            if future_count < self.MIN_PLAYERS:
                self._cancel_countdown_locked()
                if future_count >= 0:
                    # Tell remaining players the timer's off
                    asyncio.create_task(
                        self._broadcast(room, S.msg(S.MATCH_COUNTDOWN_CANCEL))
                    )
            if future_count == 0:
                self._pending_id = None

    async def announce_countdown(self, room: Room) -> None:
        """Broadcast the current countdown deadline to a room (call after
        peer_joined so the new player learns the existing timer)."""
        if self._deadline_ms is None or self._pending_id != room.id:
            return
        await self._broadcast(
            room, S.msg(S.MATCH_COUNTDOWN, deadline_ms=self._deadline_ms),
        )

    # -- internal --

    def _current_pending_room(self) -> Room | None:
        if not self._pending_id:
            return None
        r = self.manager.get(self._pending_id)
        if r is None or r.state != "waiting" or len(r.players) >= self.MAX_PLAYERS:
            return None
        return r

    def _is_idle(self) -> bool:
        return self._countdown_task is None or self._countdown_task.done()

    def _reschedule_locked(self, room: Room, delay: float) -> None:
        self._cancel_countdown_locked()
        self._deadline_ms = int((time.time() + delay) * 1000)
        self._countdown_task = asyncio.create_task(self._countdown(room, delay))
        # Tell everyone in the room the new deadline
        asyncio.create_task(
            self._broadcast(
                room, S.msg(S.MATCH_COUNTDOWN, deadline_ms=self._deadline_ms),
            )
        )

    def _cancel_countdown_locked(self) -> None:
        if self._countdown_task and not self._countdown_task.done():
            self._countdown_task.cancel()
        self._countdown_task = None
        self._deadline_ms = None

    async def _countdown(self, room: Room, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            async with self._lock:
                if self._pending_id == room.id:
                    self._pending_id = None
                self._countdown_task = None
                self._deadline_ms = None
            log.info("random match starting room=%s players=%d", room.id, len(room.players))
            await self._on_start(room)
        except asyncio.CancelledError:
            pass
