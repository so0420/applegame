"""WebSocket message dispatch — all game flow lives here."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .. import schemas as S
from ..game.board import validate_and_clear
from ..game.room import (
    CAPACITY_DEFAULT,
    CAPACITY_MAX,
    CAPACITY_MIN,
    GAME_DURATION,
    Player,
    Room,
)
from ..matchmaking import Matchmaker
from .manager import RoomManager, broadcast, make_player, send

log = logging.getLogger(__name__)

DISCONNECT_GRACE = 300.0  # seconds — keep room alive when all players disconnected


def _parse_capacity(raw: object) -> int:
    """Coerce a capacity hint from the client into [CAPACITY_MIN, CAPACITY_MAX]."""
    try:
        n = int(raw) if raw is not None else CAPACITY_DEFAULT
    except (TypeError, ValueError):
        n = CAPACITY_DEFAULT
    return max(CAPACITY_MIN, min(CAPACITY_MAX, n))


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

        if intent == "reconnect":
            target_pid = (hello.get("player_id") or "").strip()
            target_rid = (hello.get("room_id") or "").strip().upper()
            r = manager.get(target_rid)
            if r is None:
                await ws.send_json(S.msg(S.NOT_FOUND))
                await ws.close()
                return
            async with r.lock:
                existing = r.players.get(target_pid)
                if existing is None or r.state == "waiting":
                    await ws.send_json(S.msg(S.NOT_FOUND))
                    await ws.close()
                    return
                # Reject if another live session already owns this player slot.
                # The original tab keeps playing; the new tab is told why.
                if existing.connected and existing.ws is not None:
                    await ws.send_json(S.msg(
                        S.ERROR,
                        code="already_connected",
                        message="another tab is already connected to this game",
                    ))
                    await ws.close()
                    return
                existing.ws = ws
                existing.connected = True
            # Cancel any pending room cleanup
            if r.cleanup_task and not r.cleanup_task.done():
                r.cleanup_task.cancel()
                r.cleanup_task = None
            player = existing
            room = r
            await send(player, S.msg(
                S.RECONNECTED,
                player_id=player.id,
                room=room.public(),
                boards=room.boards,
                initial_board=room.initial_board,
                events=room.events,
                scores={p.id: p.score for p in room.players.values()},
                ends_at=room.ends_at,
                state=room.state,
                winner_id=room.winner_id,
            ))
            await broadcast(
                room,
                S.msg(S.PEER_RECONNECTED, player_id=player.id),
                exclude=player.id,
            )
            # Skip the join/auto-start blocks — go straight to the message loop
            await _message_loop(ws, player, room, manager)
            return
        elif intent == "solo":
            room = await manager.create_room("solo", player)
        elif intent == "create":
            room = await manager.create_room("friend", player, capacity=CAPACITY_DEFAULT)
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
        await _cleanup(player, room, manager, matchmaker, my_ws=ws)


async def _message_loop(
    ws: WebSocket, player: Player, room: Room, manager: RoomManager
) -> None:
    while True:
        data = await ws.receive_json()
        mtype = data.get("type")

        if mtype == S.SET_CAPACITY:
            if room.mode != "friend":
                continue
            if player.id != room.host_id:
                continue
            if room.state != "waiting":
                continue
            new_cap = _parse_capacity(data.get("capacity"))
            # Cannot drop capacity below current player count
            new_cap = max(new_cap, len(room.players))
            new_cap = min(CAPACITY_MAX, new_cap)
            async with room.lock:
                room.capacity = new_cap
            await broadcast(room, S.msg(S.CAPACITY_CHANGED, capacity=new_cap))

        elif mtype == S.RENAME:
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
            if room.mode == "friend" and len(room.players) < 2:
                await send(player, S.msg(S.ERROR, code="not_ready", message="need at least 2 players"))
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
        initial = room.initial_board
    await broadcast(
        room,
        S.msg(S.GAME_START, board=initial, ends_at=room.ends_at),
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
        my_board = room.boards.get(player.id)
        if my_board is None:
            return
        cells = validate_and_clear(my_board, int(r1), int(c1), int(r2), int(c2))
        if cells is None:
            await send(player, S.msg(S.REJECT, reason="invalid_or_taken"))
            return
        now = time.time()
        gained = len(cells)
        player.score += gained
        player.last_score_ts = now
        room.apples_left[player.id] -= gained
        scores = {p.id: p.score for p in room.players.values()}
        t_ms = int((now - room.started_at) * 1000) if room.started_at else 0
        room.events.append({"t_ms": t_ms, "player_id": player.id, "cells": cells})

    await broadcast(
        room,
        S.msg(S.CLEAR, player_id=player.id, cells=cells, scores=scores, t_ms=t_ms),
    )


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
        room_snapshot = room.public()
    if room.mode == "friend":
        # Friend rooms go back to the lobby so new players can join via code
        # before the host starts the next round.
        await broadcast(room, S.msg(S.ROOM_RESET, room=room_snapshot))
    else:
        # Solo / random — just kick off another round immediately.
        await _start_game(room)


async def _cleanup(
    player: Player | None,
    room: Room | None,
    manager: RoomManager,
    matchmaker: Matchmaker,
    my_ws: WebSocket | None = None,
) -> None:
    if player is None:
        return
    if matchmaker:
        await matchmaker.cancel(player.id)
    if room is None:
        return

    async with room.lock:
        # Only mark this player disconnected if WE are still the active
        # session for them. If a newer connection has already taken over
        # (or rejected our reconnect), our cleanup must not stomp the slot.
        if player.ws is not None and player.ws is not my_ws:
            return
        player.connected = False
        player.ws = None
        in_room = player.id in room.players
        state = room.state

    if not in_room:
        return

    if state == "waiting":
        # Lobby disconnect → remove from room (no reconnect for lobby).
        async with room.lock:
            room.players.pop(player.id, None)
            empty = not room.players
        await broadcast(room, S.msg(S.PEER_LEFT, player_id=player.id))
        if empty:
            await manager.remove(room.id)
        return

    # state == "playing" or "finished": keep them in the room so they can
    # reconnect. Game does NOT end on disconnect.
    await broadcast(room, S.msg(S.PEER_DISCONNECTED, player_id=player.id))

    async with room.lock:
        all_disc = all(not p.connected for p in room.players.values())
    if all_disc:
        _schedule_room_cleanup(room, manager)


def _schedule_room_cleanup(room: Room, manager: RoomManager) -> None:
    """If everyone is disconnected, wipe the room after DISCONNECT_GRACE."""
    if room.cleanup_task and not room.cleanup_task.done():
        return  # already scheduled

    async def cleanup_after() -> None:
        try:
            await asyncio.sleep(DISCONNECT_GRACE)
            async with room.lock:
                still_all_disc = all(not p.connected for p in room.players.values())
            if not still_all_disc:
                return
            # End game if still playing, then drop the room
            if room.state == "playing":
                await _end_game(room)
            await manager.remove(room.id)
        except asyncio.CancelledError:
            pass

    room.cleanup_task = asyncio.create_task(cleanup_after())
