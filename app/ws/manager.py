"""Room registry and connection manager."""
from __future__ import annotations

import asyncio
import logging
import random
import string
import uuid
from typing import Any

from fastapi import WebSocket

from ..game.room import Player, Room, RoomMode

log = logging.getLogger(__name__)

ROOM_CODE_LEN = 6
ROOM_CODE_ALPHA = string.ascii_uppercase + string.digits


def _gen_room_id() -> str:
    return "".join(random.choices(ROOM_CODE_ALPHA, k=ROOM_CODE_LEN))


def _gen_player_id() -> str:
    return uuid.uuid4().hex[:12]


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()

    async def create_room(
        self, mode: RoomMode, host: Player, capacity: int | None = None
    ) -> Room:
        async with self._lock:
            for _ in range(10):
                rid = _gen_room_id()
                if rid not in self.rooms:
                    break
            else:
                raise RuntimeError("could not allocate room id")
            cap = capacity if capacity is not None else (1 if mode == "solo" else 2)
            # Random rooms have no host — every player can re-queue or leave
            # independently. Friend/solo rooms still pin a host.
            host_id = None if mode == "random" else host.id
            room = Room(
                id=rid,
                mode=mode,
                capacity=cap,
                host_id=host_id,
                players={host.id: host},
            )
            self.rooms[rid] = room
            log.info(
                "room created id=%s mode=%s host=%s capacity=%d",
                rid, mode, host.nickname, cap,
            )
            return room

    def get(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id.upper())

    async def remove(self, room_id: str) -> None:
        async with self._lock:
            room = self.rooms.pop(room_id, None)
            if room:
                for task in (room.timer_task, room.drought_task):
                    if task and not task.done():
                        task.cancel()
                log.info("room removed id=%s", room_id)


def make_player(nickname: str, ws: WebSocket | None = None) -> Player:
    pid = _gen_player_id()
    nick = (nickname or "").strip()[:20]
    if not nick:
        nick = f"Player-{pid[:4].upper()}"
    return Player(id=pid, nickname=nick, ws=ws)


async def broadcast(room: Room, message: dict[str, Any], exclude: str | None = None) -> None:
    # Spectators receive the same live feed as players (clears, drags, item
    # effects, game_end) so a mid-game watcher sees the round unfold.
    targets = [
        p
        for p in (*room.players.values(), *room.spectators.values())
        if p.ws and p.id != exclude
    ]
    if not targets:
        return
    await asyncio.gather(
        *(p.ws.send_json(message) for p in targets if p.ws),
        return_exceptions=True,
    )


async def send(player: Player, message: dict[str, Any]) -> None:
    if player.ws is None:
        return
    try:
        await player.ws.send_json(message)
    except Exception as e:  # noqa: BLE001
        log.debug("send failed to %s: %s", player.id, e)
