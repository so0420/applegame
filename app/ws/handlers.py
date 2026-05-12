"""WebSocket message dispatch — all game flow lives here."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .. import schemas as S
from ..game.board import (
    find_sum10_pair,
    random_apple_cell,
    shuffle_remaining,
    validate_and_clear,
)
from ..game.room import (
    ATTACK_LOCKOUT,
    CAPACITY_DEFAULT,
    CAPACITY_MAX,
    CAPACITY_MIN,
    EFFECT_BLIND,
    EFFECT_DOUBLE,
    EFFECT_HINT,
    GAME_DURATION,
    GOLDEN_INTERVAL,
    INVENTORY_SIZE,
    ITEM_KINDS,
    Player,
    Room,
)
from ..matchmaking import Matchmaker
from .manager import RoomManager, broadcast, make_player, send

log = logging.getLogger(__name__)

DISCONNECT_GRACE = 300.0  # seconds — keep room alive when all players disconnected

ATTACK_ITEMS = {"blind", "shuffle"}


def _t_ms(room: Room) -> int:
    """Milliseconds since this round started — used for replay event ordering."""
    if room.started_at is None:
        return 0
    return int((time.time() - room.started_at) * 1000)


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

        # Random match: ignore client-supplied nickname so all players are
        # auto-assigned Player-XXXX. Random matches stay anonymous.
        if intent == "match":
            nickname = ""
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
            room, _deadline_ms = await matchmaker.enqueue(player)
        else:
            await ws.send_json(S.msg(S.ERROR, code="bad_intent", message=f"unknown intent {intent!r}"))
            await ws.close()
            return

        # 2. Notify joined
        await send(player, S.msg(S.JOINED, player_id=player.id, room=room.public()))
        await broadcast(room, S.msg(S.PEER_JOINED, player=player.public()), exclude=player.id)

        # 3. Auto-start for solo. Random match starts via matchmaker
        # countdown; tell the new player the current deadline if any.
        if room.mode == "solo":
            await _start_game(room)
        elif room.mode == "random":
            await matchmaker.announce_countdown(room)

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

        elif mtype == S.SET_VARIANT:
            if room.mode != "friend":
                continue
            if player.id != room.host_id:
                continue
            if room.state != "waiting":
                continue
            new_variant = data.get("variant")
            if new_variant not in ("classic", "items"):
                continue
            async with room.lock:
                room.variant = new_variant
            await broadcast(room, S.msg(S.VARIANT_CHANGED, variant=new_variant))

        elif mtype == S.RENAME:
            if room.mode == "random":
                continue  # random matches stay anonymous
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
            new_drag = (r1, c1, r2, c2)
            # Skip if rect hasn't moved — saves a broadcast per peer.
            if player.last_drag == new_drag:
                continue
            player.last_drag = new_drag
            await broadcast(
                room,
                S.msg(S.PEER_DRAG, player_id=player.id, r1=r1, c1=c1, r2=r2, c2=c2),
                exclude=player.id,
            )

        elif mtype == S.SUBMIT:
            if room.state != "playing":
                continue
            await _handle_submit(room, player, data)

        elif mtype == S.USE_ITEM:
            if room.state != "playing":
                continue
            if room.variant != "items":
                continue
            await _handle_use_item(room, player, data)

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
        variant = room.variant
    await broadcast(
        room,
        S.msg(S.GAME_START, board=initial, ends_at=room.ends_at, variant=variant),
    )

    async def end_after_timeout() -> None:
        try:
            await asyncio.sleep(GAME_DURATION)
            await _end_game(room)
        except asyncio.CancelledError:
            pass

    room.timer_task = asyncio.create_task(end_after_timeout())

    if variant == "items":
        room.golden_task = asyncio.create_task(_golden_spawn_loop(room))


async def _handle_submit(room: Room, player: Player, data: dict[str, Any]) -> None:
    r1, c1, r2, c2 = data.get("r1"), data.get("c1"), data.get("r2"), data.get("c2")
    if None in (r1, c1, r2, c2):
        return
    item_msg: dict[str, Any] | None = None
    gold_hit = False
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
        # 2× multiplier — applied if the effect is still active. Bonus is
        # tracked as added apples-equivalent so the existing scoring model
        # (score == apples-cleared count in classic mode) stays unified.
        if room.variant == "items" and player.double_until > now:
            gained *= 2
        player.score += gained
        player.last_score_ts = now
        # apples_left tracks raw cells removed (used elsewhere as physical
        # progress), so subtract the raw count, not the doubled score.
        room.apples_left[player.id] -= len(cells)
        scores = {p.id: p.score for p in room.players.values()}
        t_ms = int((now - room.started_at) * 1000) if room.started_at else 0
        room.events.append({
            "kind": "clear",
            "t_ms": t_ms,
            "player_id": player.id,
            "cells": cells,
        })

        # Golden-apple pickup → grant a random item if there's a free slot.
        if room.variant == "items":
            golden_cells = room.golden.get(player.id) or set()
            consumed = [cell for cell in cells if tuple(cell) in golden_cells]
            if consumed:
                gold_hit = True
                for cell in consumed:
                    golden_cells.discard(tuple(cell))
                free_slot = next(
                    (i for i, s in enumerate(player.inventory) if s is None),
                    None,
                )
                if free_slot is not None:
                    item = random.choice(ITEM_KINDS)
                    player.inventory[free_slot] = item
                    item_msg = S.msg(
                        S.ITEM_ACQUIRED,
                        player_id=player.id,
                        slot=free_slot,
                        item=item,
                    )

    await broadcast(
        room,
        S.msg(
            S.CLEAR,
            player_id=player.id,
            cells=cells,
            scores=scores,
            t_ms=t_ms,
            gold_hit=gold_hit,
        ),
    )
    if item_msg is not None:
        # Only the receiving player needs to know which item dropped —
        # opponents only see the inventory count update via room state.
        await send(player, item_msg)


async def _golden_spawn_loop(room: Room) -> None:
    """Periodically mark an existing apple on each player's board as golden."""
    try:
        while True:
            await asyncio.sleep(GOLDEN_INTERVAL)
            spawns: list[tuple[str, int, int, int]] = []
            async with room.lock:
                if room.state != "playing":
                    return
                t_ms = _t_ms(room)
                for pid, board in room.boards.items():
                    existing = room.golden.setdefault(pid, set())
                    # Promote an already-on-board apple to golden so the
                    # client doesn't need to learn a new cell value — the
                    # apple value it's drawing stays the same.
                    cell = random_apple_cell(board, exclude=existing)
                    if cell is None:
                        continue
                    existing.add(cell)
                    spawns.append((pid, cell[0], cell[1], t_ms))
                    room.events.append({
                        "kind": "golden",
                        "t_ms": t_ms,
                        "player_id": pid,
                        "r": cell[0],
                        "c": cell[1],
                    })
            for pid, r, c, t_ms in spawns:
                await broadcast(
                    room,
                    S.msg(S.GOLDEN_SPAWN, player_id=pid, r=r, c=c, t_ms=t_ms),
                )
    except asyncio.CancelledError:
        pass


def _pick_attack_target(room: Room, attacker_id: str) -> str | None:
    """Top-3 by score (attacker excluded) → random one of them.
    Falls back to any other connected player when <3 candidates."""
    candidates = [
        p for p in room.players.values()
        if p.id != attacker_id and p.connected
    ]
    if not candidates:
        return None
    candidates.sort(
        key=lambda p: (-p.score, p.last_score_ts or float("inf")),
    )
    pool = candidates[:3]
    return random.choice(pool).id


async def _handle_use_item(
    room: Room, player: Player, data: dict[str, Any]
) -> None:
    slot = data.get("slot")
    if not isinstance(slot, int) or not (0 <= slot < INVENTORY_SIZE):
        return
    now = time.time()
    payload: dict[str, Any] = {}
    async with room.lock:
        if room.state != "playing":
            return
        item = player.inventory[slot]
        if item is None:
            return
        # Late-game lockout for attack items so a last-second strike can't
        # decide the match unfairly.
        remaining = (room.ends_at or now) - now
        if item in ATTACK_ITEMS and remaining <= ATTACK_LOCKOUT:
            await send(player, S.msg(
                S.ERROR, code="attack_locked",
                message="공격 아이템은 마지막 10초 전부터 사용할 수 없습니다",
            ))
            return
        target_id: str | None = None
        if item == "hint":
            pair = find_sum10_pair(room.boards.get(player.id, []))
            payload["hint"] = [{"r": r, "c": c} for (r, c) in (pair or [])]
            target_id = player.id
            until = now + EFFECT_HINT
        elif item == "double":
            target_id = player.id
            player.double_until = now + EFFECT_DOUBLE
            until = player.double_until
        elif item == "blind":
            target_id = _pick_attack_target(room, player.id)
            if target_id is None:
                return
            target = room.players[target_id]
            target.blind_until = now + EFFECT_BLIND
            until = target.blind_until
        elif item == "shuffle":
            target_id = _pick_attack_target(room, player.id)
            if target_id is None:
                return
            target_board = room.boards.get(target_id)
            if target_board is None:
                return
            shuffle_remaining(target_board)
            # Shuffle invalidates the previous golden positions (values
            # were rerolled), so the gold flag stays at those cells but
            # the apple beneath is now random — that's fine; picking it
            # up still grants an item.
            until = now  # one-shot effect
        else:
            return
        # Consume the slot
        player.inventory[slot] = None
        payload["target_id"] = target_id
        t_ms = _t_ms(room)
        room.events.append({
            "kind": "item_used",
            "t_ms": t_ms,
            "by": player.id,
            "item": item,
            "target_id": target_id,
        })

    used_msg = S.msg(
        S.ITEM_USED,
        by=player.id,
        item=item,
        target_id=payload.get("target_id"),
        t_ms=t_ms,
    )
    await broadcast(room, used_msg)

    if item == "shuffle":
        # Tell every client the new board for the target so optimistic
        # state stays consistent.
        async with room.lock:
            board_copy = [row[:] for row in room.boards[target_id]]
            shuffle_t_ms = _t_ms(room)
            room.events.append({
                "kind": "shuffle",
                "t_ms": shuffle_t_ms,
                "target_id": target_id,
                "board": board_copy,
            })
        await broadcast(
            room,
            S.msg(
                S.BOARD_UPDATE,
                target_id=target_id,
                board=board_copy,
                t_ms=shuffle_t_ms,
            ),
        )
        return

    # Timed effects: announce start + schedule end
    until_ms = int(until * 1000)
    start_payload: dict[str, Any] = {
        "target_id": target_id,
        "effect": item,
        "until_ms": until_ms,
        "t_ms": t_ms,
    }
    if item == "hint":
        start_payload["hint"] = payload["hint"]
    async with room.lock:
        room.events.append({
            "kind": "effect_start",
            "t_ms": t_ms,
            "target_id": target_id,
            "effect": item,
            "until_ms": until_ms,
            **({"hint": payload["hint"]} if item == "hint" else {}),
        })
    await broadcast(room, S.msg(S.EFFECT_START, **start_payload))

    delay = max(0.0, until - now)
    if delay > 0:
        asyncio.create_task(_clear_effect_after(room, target_id, item, delay))


async def _clear_effect_after(
    room: Room, target_id: str, effect: str, delay: float
) -> None:
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    if room.state != "playing":
        return
    async with room.lock:
        t_ms = _t_ms(room)
        room.events.append({
            "kind": "effect_end",
            "t_ms": t_ms,
            "target_id": target_id,
            "effect": effect,
        })
    await broadcast(
        room,
        S.msg(S.EFFECT_END, target_id=target_id, effect=effect, t_ms=t_ms),
    )


async def _end_game(room: Room) -> None:
    async with room.lock:
        if room.state == "finished":
            return
        room.state = "finished"
        timer = room.timer_task
        room.timer_task = None
        golden = room.golden_task
        room.golden_task = None
        room.winner_id = room.determine_winner()
        scores = {p.id: p.score for p in room.players.values()}
    # Cancel the timeout task only if we're ending early (not from inside it).
    # Cancelling the current task would interrupt the broadcast below.
    current = asyncio.current_task()
    if timer is not None and timer is not current and not timer.done():
        timer.cancel()
    if golden is not None and not golden.done():
        golden.cancel()
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
        # Random matchmaking room: ask matchmaker first so it can cancel
        # any countdown that should no longer fire.
        if room.mode == "random":
            await matchmaker.player_left(player.id, room)
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
