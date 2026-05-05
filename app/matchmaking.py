"""Random matchmaking queue."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .game.room import Player, Room

if TYPE_CHECKING:
    from .ws.manager import RoomManager

log = logging.getLogger(__name__)


@dataclass
class _Waiter:
    player: Player
    future: asyncio.Future[Room]


class Matchmaker:
    def __init__(self, manager: "RoomManager") -> None:
        self.manager = manager
        self._queue: list[_Waiter] = []
        self._lock = asyncio.Lock()

    async def enqueue(self, player: Player) -> Room | asyncio.Future[Room]:
        """Add player to queue.

        If an opponent is already waiting, immediately create a room and
        resolve the opponent's future. Returns the Room.
        Otherwise returns a Future the caller should await.
        """
        async with self._lock:
            self._prune_locked()
            if self._queue:
                waiter = self._queue.pop(0)
                opponent = waiter.player
                room = await self.manager.create_room("random", opponent)
                room.players[player.id] = player
                log.info(
                    "matched %s vs %s in room %s",
                    opponent.nickname,
                    player.nickname,
                    room.id,
                )
                if not waiter.future.done():
                    waiter.future.set_result(room)
                return room
            fut: asyncio.Future[Room] = asyncio.get_event_loop().create_future()
            self._queue.append(_Waiter(player=player, future=fut))
            return fut

    async def cancel(self, player_id: str) -> None:
        async with self._lock:
            keep: list[_Waiter] = []
            for w in self._queue:
                if w.player.id == player_id:
                    if not w.future.done():
                        w.future.cancel()
                else:
                    keep.append(w)
            self._queue = keep

    def position(self, player_id: str) -> int:
        for i, w in enumerate(self._queue):
            if w.player.id == player_id:
                return i + 1
        return 0

    def _prune_locked(self) -> None:
        self._queue = [w for w in self._queue if w.player.connected and not w.future.done()]
