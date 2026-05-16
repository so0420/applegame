"""Random matchmaking — one growing waiting room per variant.

Each variant ("classic", "items") has its own pending room and countdown
so players only get matched with others who picked the same variant. The
countdown starts when 2 players share a variant (20 s) and short-circuits
to 5 s when the room hits 7. When the timer fires the round is started.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Awaitable, Callable

from . import schemas as S
from .game.room import Player, Room, RoomVariant
from .ws.manager import send

if TYPE_CHECKING:
    from .ws.manager import RoomManager

log = logging.getLogger(__name__)


_VARIANTS: tuple[RoomVariant, ...] = ("classic", "items")


class Matchmaker:
    MIN_PLAYERS = 2
    MAX_PLAYERS = 7
    WAIT_AFTER_PAIR = 20.0     # seconds after 2nd player joins
    WAIT_WHEN_FULL = 5.0       # seconds once we hit MAX_PLAYERS

    def __init__(
        self,
        manager: "RoomManager",
        on_start: Callable[[Room], Awaitable[None]],
        broadcast: Callable[..., Awaitable[None]],
    ) -> None:
        self.manager = manager
        self._on_start = on_start
        self._broadcast = broadcast
        # One pending slot per variant: each tracks its own room id,
        # countdown task, and deadline_ms.
        self._pending: dict[RoomVariant, dict[str, object | None]] = {
            v: {"room_id": None, "task": None, "deadline_ms": None}
            for v in _VARIANTS
        }
        self._lock = asyncio.Lock()

    @property
    def deadline_ms(self) -> int | None:
        """Back-compat shim: classic variant's deadline, for old tests."""
        return self._pending["classic"]["deadline_ms"]  # type: ignore[return-value]

    def deadline_ms_for(self, variant: RoomVariant) -> int | None:
        slot = self._pending.get(variant)
        return slot["deadline_ms"] if slot else None  # type: ignore[return-value]

    async def enqueue(
        self, player: Player, variant: RoomVariant = "classic",
    ) -> tuple[Room, int | None]:
        """Add player to the current pending room for `variant` (creating
        one if needed). Returns (room, deadline_ms) — deadline_ms is None
        if no countdown is running yet.
        """
        if variant not in _VARIANTS:
            variant = "classic"
        async with self._lock:
            slot = self._pending[variant]
            room = self._current_pending_room(variant)
            if room is None:
                room = await self.manager.create_room(
                    "random", player, capacity=self.MAX_PLAYERS,
                )
                # Random rooms inherit the player-picked variant.
                room.variant = variant
                slot["room_id"] = room.id
            else:
                async with room.lock:
                    room.players[player.id] = player

            count = len(room.players)
            if count >= self.MAX_PLAYERS:
                self._reschedule_locked(room, variant, self.WAIT_WHEN_FULL)
            elif count >= self.MIN_PLAYERS and self._is_idle(variant):
                self._reschedule_locked(room, variant, self.WAIT_AFTER_PAIR)
            return room, slot["deadline_ms"]  # type: ignore[return-value]

    async def player_left(self, player_id: str, room: Room) -> None:
        """A player left a pending random room. Cancel countdown if we drop
        below MIN_PLAYERS, drop the room slot entirely if it's empty."""
        async with self._lock:
            variant = room.variant if room.variant in _VARIANTS else "classic"
            slot = self._pending[variant]
            if slot["room_id"] != room.id:
                return  # not our pending room
            future_count = len(room.players) - (1 if player_id in room.players else 0)
            if future_count < self.MIN_PLAYERS:
                self._cancel_countdown_locked(variant)
                if future_count >= 0:
                    # Tell remaining players the timer's off
                    asyncio.create_task(
                        self._broadcast(room, S.msg(S.MATCH_COUNTDOWN_CANCEL))
                    )
            if future_count == 0:
                slot["room_id"] = None

    async def announce_countdown(self, room: Room, player: Player) -> None:
        """Tell a newly-joined player the current countdown deadline.

        Existing players already received the countdown via the broadcast
        in _reschedule_locked (which fires whenever the deadline changes),
        so this is a unicast — sending to the whole room would double up
        every join-triggered countdown reset.
        """
        variant = room.variant if room.variant in _VARIANTS else "classic"
        slot = self._pending[variant]
        if slot["deadline_ms"] is None or slot["room_id"] != room.id:
            return
        await send(
            player, S.msg(S.MATCH_COUNTDOWN, deadline_ms=slot["deadline_ms"]),
        )

    # -- internal --

    def _current_pending_room(self, variant: RoomVariant) -> Room | None:
        slot = self._pending[variant]
        rid = slot["room_id"]
        if not rid:
            return None
        r = self.manager.get(rid)  # type: ignore[arg-type]
        if r is None or r.state != "waiting" or len(r.players) >= self.MAX_PLAYERS:
            return None
        return r

    def _is_idle(self, variant: RoomVariant) -> bool:
        task = self._pending[variant]["task"]
        return task is None or task.done()  # type: ignore[union-attr]

    def _reschedule_locked(
        self, room: Room, variant: RoomVariant, delay: float,
    ) -> None:
        self._cancel_countdown_locked(variant)
        slot = self._pending[variant]
        slot["deadline_ms"] = int((time.time() + delay) * 1000)
        slot["task"] = asyncio.create_task(self._countdown(room, variant, delay))
        # Tell everyone in the room the new deadline
        asyncio.create_task(
            self._broadcast(
                room, S.msg(S.MATCH_COUNTDOWN, deadline_ms=slot["deadline_ms"]),
            )
        )

    def _cancel_countdown_locked(self, variant: RoomVariant) -> None:
        slot = self._pending[variant]
        task = slot["task"]
        if task is not None and not task.done():  # type: ignore[union-attr]
            task.cancel()  # type: ignore[union-attr]
        slot["task"] = None
        slot["deadline_ms"] = None

    async def _countdown(
        self, room: Room, variant: RoomVariant, delay: float,
    ) -> None:
        try:
            await asyncio.sleep(delay)
            async with self._lock:
                slot = self._pending[variant]
                if slot["room_id"] == room.id:
                    slot["room_id"] = None
                slot["task"] = None
                slot["deadline_ms"] = None
            log.info(
                "random match starting room=%s variant=%s players=%d",
                room.id, variant, len(room.players),
            )
            await self._on_start(room)
        except asyncio.CancelledError:
            pass
