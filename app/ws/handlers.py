"""WebSocket message dispatch — all game flow lives here."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .. import schemas as S
from ..game.board import validate_and_clear
from ..game.room import GAME_DURATION, Player, Room
from ..matchmaking import Matchmaker
from .manager import RoomManager, broadcast, make_player, send

log = logging.getLogger(__name__)

DISCONNECT_GRACE = 30.0  # seconds


async def session(
    ws: WebSocket,
    manager: RoomManager,
    matchmaker: Matchmaker,
) -> None:
    """One WebSocket session lifecycle: hello → room → game → cleanup."""
    await ws.accept()

    player: Player | None = None
    room: Room | None = None

    try:
        # 1. Wait for hello
        hello = await ws.receive_json()
        if hello.get("type") != S.HELLO:
            await ws.send_json(S.msg(S.ERROR, code="expected_hello", message="first message must be hello"))
            await ws.close()
            return

        nickname = hello.get("nickname", "")
        intent = hello.get("intent", "solo")
        code = (hello.get("code") or "").strip().upper()

        player = make_player(nickname, ws=ws)

        if intent == "solo":
            room = await manager.create_room("solo", player)
        elif intent == "create":
            room = await manager.create_room("friend", player)
        elif intent == "join":
            room = manager.get(code)
            if room is None:
                await ws.send_json(S.msg(S.NOT_FOUND))
                await ws.close()
                return
            if room.is_full or room.state != "waiting":
                await ws.send_json(S.msg(S.ROOM_FULL))
                await ws.close()
                return
            async with room.lock:
                room.players[player.id] = player
        elif intent == "match":
            result = await matchmaker.enqueue(player)
            if isinstance(result, Room):
                room = result
            else:
                await send(player, S.msg(S.QUEUED, position=matchmaker.position(player.id)))
                try:
                    room = await result
                except asyncio.CancelledError:
                    return
        else:
            await ws.send_json(S.msg(S.ERROR, code="bad_intent", message=f"unknown intent {intent!r}"))
            await ws.close()
            return

        # 2. Notify joined
        await send(player, S.msg(S.JOINED, player_id=player.id, room=room.public()))
        await broadcast(room, S.msg(S.PEER_JOINED, player=player.public()), exclude=player.id)

        # 3. Auto-start for solo and random match (when both joined)
        if room.mode == "solo":
            await _start_game(room)
        elif room.mode == "random" and room.is_full and room.state == "waiting":
            await _start_game(room)

        # 4. Main message loop
        await _message_loop(ws, player, room, manager)

    except WebSocketDisconnect:
        log.info("ws disconnect player=%s", player.id if player else "?")
    except Exception:
        log.exception("session error")
    finally:
        await _cleanup(player, room, manager, matchmaker)


async def _message_loop(
    ws: WebSocket, player: Player, room: Room, manager: RoomManager
) -> None:
    while True:
        data = await ws.receive_json()
        mtype = data.get("type")

        if mtype == S.RENAME:
            new = (data.get("nickname") or "").strip()[:20]
            if not new:
                continue
            player.nickname = new
            await broadcast(
                room,
                S.msg(S.RENAMED, player_id=player.id, nickname=new),
            )

        elif mtype == S.START:
            if room.state != "waiting":
                continue
            if room.mode == "friend" and player.id != room.host_id:
                await send(player, S.msg(S.ERROR, code="not_host", message="host only"))
                continue
            if room.mode == "friend" and not room.is_full:
                await send(player, S.msg(S.ERROR, code="not_ready", message="waiting for opponent"))
                continue
            await _start_game(room)

        elif mtype == S.DRAG_UPDATE:
            if room.state != "playing":
                continue
            r1, c1, r2, c2 = (data.get("r1"), data.get("c1"), data.get("r2"), data.get("c2"))
            if None in (r1, c1, r2, c2):
                continue
            player.last_drag = (r1, c1, r2, c2)
            await broadcast(
                room,
                S.msg(S.PEER_DRAG, player_id=player.id, r1=r1, c1=c1, r2=r2, c2=c2),
                exclude=player.id,
            )

        elif mtype == S.SUBMIT:
            if room.state != "playing":
                continue
            await _handle_submit(room, player, data)

        elif mtype == S.REMATCH:
            await _handle_rematch(room, player)

        elif mtype == S.LEAVE:
            return


async def _start_game(room: Room) -> None:
    async with room.lock:
        if room.state == "playing":
            return
        room.start()
    await broadcast(
        room,
        S.msg(S.GAME_START, board=room.board, ends_at=room.ends_at),
    )

    async def end_after_timeout() -> None:
        try:
            await asyncio.sleep(GAME_DURATION)
            await _end_game(room)
        except asyncio.CancelledError:
            pass

    room.timer_task = asyncio.create_task(end_after_timeout())


async def _handle_submit(room: Room, player: Player, data: dict[str, Any]) -> None:
    r1, c1, r2, c2 = data.get("r1"), data.get("c1"), data.get("r2"), data.get("c2")
    if None in (r1, c1, r2, c2):
        return
    async with room.lock:
        if room.state != "playing":
            return
        cells = validate_and_clear(room.board, int(r1), int(c1), int(r2), int(c2))
        if cells is None:
            await send(player, S.msg(S.REJECT, reason="invalid_or_taken"))
            return
        gained = len(cells)
        player.score += gained
        player.last_score_ts = time.time()
        room.apples_left -= gained
        scores = {p.id: p.score for p in room.players.values()}
        all_cleared = room.apples_left <= 0

    await broadcast(
        room,
        S.msg(S.CLEAR, player_id=player.id, cells=cells, scores=scores),
    )
    if all_cleared:
        await _end_game(room)


async def _end_game(room: Room) -> None:
    async with room.lock:
        if room.state == "finished":
            return
        room.state = "finished"
        timer = room.timer_task
        room.timer_task = None
        room.winner_id = room.determine_winner()
        scores = {p.id: p.score for p in room.players.values()}
    # Cancel the timeout task only if we're ending early (not from inside it).
    # Cancelling the current task would interrupt the broadcast below.
    current = asyncio.current_task()
    if timer is not None and timer is not current and not timer.done():
        timer.cancel()
    await broadcast(
        room,
        S.msg(S.GAME_END, scores=scores, winner_id=room.winner_id),
    )


async def _handle_rematch(room: Room, player: Player) -> None:
    async with room.lock:
        if room.state != "finished":
            return
        # Only host (friend mode) or any player (solo/random) can trigger rematch
        if room.mode == "friend" and player.id != room.host_id:
            return
        room.reset_for_rematch()
    await _start_game(room)


async def _cleanup(
    player: Player | None,
    room: Room | None,
    manager: RoomManager,
    matchmaker: Matchmaker,
) -> None:
    if player is None:
        return
    player.connected = False
    if matchmaker:
        await matchmaker.cancel(player.id)
    if room is None:
        return

    async with room.lock:
        in_room = player.id in room.players
        playing = room.state == "playing"

    if not in_room:
        return

    if playing:
        # Forfeit: remaining player wins by abandonment
        async with room.lock:
            room.players.pop(player.id, None)
        await broadcast(room, S.msg(S.PEER_LEFT, player_id=player.id))
        await _end_game(room)
        await manager.remove(room.id)
    else:
        async with room.lock:
            room.players.pop(player.id, None)
        await broadcast(room, S.msg(S.PEER_LEFT, player_id=player.id))
        if not room.players:
            await manager.remove(room.id)
