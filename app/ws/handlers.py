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
    find_sum10_rect,
    shuffle_remaining,
    validate_and_clear,
)
from ..game.room import (
    ATTACK_LOCKOUT,
    BIG_CLEAR_CELLS,
    CAPACITY_DEFAULT,
    CAPACITY_MAX,
    CAPACITY_MIN,
    COMBO_THRESHOLD,
    COMBO_WINDOW_S,
    DROUGHT_SECONDS,
    EFFECT_BLIND,
    EFFECT_FREEZE,
    EFFECT_HINT,
    EFFECT_OVERLOAD,
    EFFECT_SHIELD,
    GAME_DURATION,
    INVENTORY_SIZE,
    ITEM_DROP_WEIGHTS,
    ITEM_KINDS,
    MAX_SUBMITS_PER_1S,
    MAX_SUBMITS_PER_3S,
    MIN_SUBMIT_GAP_S,
    TEAM_MIN_PLAYERS,
    Player,
    Room,
)
from ..matchmaking import Matchmaker
from .manager import RoomManager, broadcast, make_player, send

log = logging.getLogger(__name__)

DISCONNECT_GRACE = 300.0  # seconds — keep room alive when all players disconnected

ATTACK_ITEMS = {"blind", "overload", "freeze"}

# AI partner (team mode) pacing — seconds per clear. The bot mirrors its
# human partner's recent cadence, clamped to this band so it never carries
# nor dead-weights the team.
BOT_DEFAULT_DELAY = 2.6
BOT_MIN_DELAY = 1.2
BOT_MAX_DELAY = 4.5

# Test seam. Always True in production. The periodic drought-relief and AI
# bot loops broadcast on a timer; under Starlette's TestClient each WS
# connection runs in its own event loop, so a timer broadcast from one loop
# can race cross-loop delivery and make multi-connection tests flaky.
# conftest flips this off by default; tests that exercise those loops turn it
# back on. Production uses a single event loop, so this never matters there.
BACKGROUND_LOOPS_ENABLED = True

# Player attribute holding each timed effect's expiry. Lets the
# effect-expiry task re-check the live deadline so a re-applied effect
# (e.g. stacking shields) isn't ended early by an older pending timer.
EFFECT_DEADLINE_ATTR = {
    "shield": "shield_until",
    "blind": "blind_until",
    "overload": "overload_until",
    "freeze": "freeze_until",
}


def _t_ms(room: Room) -> int:
    """Milliseconds since this round started — used for replay event ordering."""
    if room.started_at is None:
        return 0
    return int((time.time() - room.started_at) * 1000)


def _state_snapshot(room: Room) -> dict[str, Any]:
    """Full game-state snapshot shared by reconnect and spectate.

    Everything a client needs to render the live round from scratch:
    per-player boards, the replay event log, scores, deadlines, and the
    golden-apple positions (initial + per-player remaining)."""
    return {
        "room": room.public(),
        "boards": room.boards,
        "initial_board": room.initial_board,
        "events": room.events,
        "scores": {a.id: a.score for a in room.actors()},
        "ends_at": room.ends_at,
        "state": room.state,
        "winner_id": room.winner_id,
        "initial_golden": [[r, c] for (r, c) in room.initial_golden],
        "golden": {
            pid: [[gr, gc] for (gr, gc) in cells]
            for pid, cells in room.golden.items()
        },
    }


def _anti_macro_reject_reason(player: Player, now: float) -> str | None:
    """Return a reject reason string if this submit looks automated.

    Two rate gates: minimum inter-submit gap and sliding-window caps.
    """
    history = player.submit_history
    if history and (now - history[-1]) < MIN_SUBMIT_GAP_S:
        return "too_fast"
    in_1s = sum(1 for ts in history if now - ts <= 1.0)
    if in_1s >= MAX_SUBMITS_PER_1S:
        return "rate_limited"
    in_3s = sum(1 for ts in history if now - ts <= 3.0)
    if in_3s >= MAX_SUBMITS_PER_3S:
        return "rate_limited"
    return None


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
                # Kicked players can't reconnect even if their slot lingers.
                if existing is None or r.state == "waiting" or target_pid in r.banned:
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
            # Resume drought relief + AI loops if they were stopped when the
            # room emptied.
            if (
                BACKGROUND_LOOPS_ENABLED
                and r.state == "playing"
                and r.variant in ("items", "team")
                and (r.drought_task is None or r.drought_task.done())
            ):
                r.drought_task = asyncio.create_task(_drought_loop(r))
            if (
                BACKGROUND_LOOPS_ENABLED
                and r.state == "playing"
                and r.variant == "team"
                and not any(not bt.done() for bt in r.bot_tasks)
                and any(m.is_bot for t in r.teams.values() for m in t.members)
            ):
                _start_bot_loops(r)
            player = existing
            room = r
            await send(player, S.msg(
                S.RECONNECTED,
                player_id=player.id,
                **_state_snapshot(room),
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
            # Friend rooms default to items mode — the variant most hosts pick.
            room.variant = "items"
        elif intent == "join":
            room = manager.get(code)
            if room is None:
                await ws.send_json(S.msg(S.NOT_FOUND))
                await ws.close()
                return
            if room.state == "waiting":
                if room.is_full:
                    await ws.send_json(S.msg(S.ROOM_FULL))
                    await ws.close()
                    return
                async with room.lock:
                    room.players[player.id] = player
            elif room.mode == "friend":
                # Round already running (or finished): admit as a spectator
                # rather than bouncing them. They watch live and are promoted
                # to a real player when the room returns to the lobby.
                async with room.lock:
                    room.spectators[player.id] = player
                # A watcher arriving cancels any pending all-disconnected wipe.
                if room.cleanup_task and not room.cleanup_task.done():
                    room.cleanup_task.cancel()
                    room.cleanup_task = None
                await send(player, S.msg(
                    S.SPECTATE,
                    player_id=player.id,
                    **_state_snapshot(room),
                ))
                await _message_loop(ws, player, room, manager)
                return
            else:
                # solo / random rooms aren't spectatable via code.
                await ws.send_json(S.msg(S.ROOM_FULL))
                await ws.close()
                return
        elif intent == "match":
            raw_variant = hello.get("variant", "classic")
            match_variant = (
                raw_variant if raw_variant in ("classic", "items", "team") else "classic"
            )
            room, _deadline_ms = await matchmaker.enqueue(player, variant=match_variant)
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
            await matchmaker.announce_countdown(room, player)

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
            if new_variant not in ("classic", "items", "team"):
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

        elif mtype == S.HOST_RENAME:
            # Host renames another player. Lobby-only, friend rooms only.
            if room.mode != "friend" or player.id != room.host_id:
                continue
            if room.state != "waiting":
                continue
            target_id = (data.get("player_id") or "").strip()
            new = (data.get("nickname") or "").strip()[:20]
            if not target_id or not new:
                continue
            target = room.players.get(target_id)
            if target is None:
                continue
            target.nickname = new
            await broadcast(
                room,
                S.msg(S.RENAMED, player_id=target_id, nickname=new),
            )

        elif mtype == S.KICK:
            # Host kicks + bans a player. Lobby-only so we never have to
            # surgically unwind a player's mid-round board / score / rank.
            if room.mode != "friend" or player.id != room.host_id:
                continue
            if room.state != "waiting":
                continue
            target_id = (data.get("player_id") or "").strip()
            if not target_id or target_id == room.host_id:
                continue
            await _handle_kick(room, target_id, manager)

        elif mtype == S.START:
            if room.state != "waiting":
                continue
            if room.mode == "friend" and player.id != room.host_id:
                await send(player, S.msg(S.ERROR, code="not_host", message="host only"))
                continue
            if room.mode == "friend":
                humans = sum(1 for p in room.players.values() if not p.is_bot)
                need = TEAM_MIN_PLAYERS if room.variant == "team" else 2
                if humans < need:
                    await send(player, S.msg(
                        S.ERROR, code="not_ready",
                        message=f"need at least {need} players",
                    ))
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
            # owner_id = the board this drag draws on (team in team mode).
            actor = room.actor_for(player.id)
            owner_id = actor.id if actor is not None else player.id
            await broadcast(
                room,
                S.msg(
                    S.PEER_DRAG, player_id=player.id, owner_id=owner_id,
                    r1=r1, c1=c1, r2=r2, c2=c2,
                ),
                exclude=player.id,
            )

        elif mtype == S.SUBMIT:
            if room.state != "playing":
                continue
            await _handle_submit(room, player, data)

        elif mtype == S.USE_ITEM:
            if room.state != "playing":
                continue
            if room.variant not in ("items", "team"):
                continue
            await _handle_use_item(room, player, data)

        elif mtype == S.DISCARD_ITEM:
            if room.state != "playing":
                continue
            if room.variant not in ("items", "team"):
                continue
            await _handle_discard_item(room, player, data)

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
        golden = [[r, c] for (r, c) in room.initial_golden]
        teams = [t.public() for t in room.teams.values()] if variant == "team" else None
    payload: dict[str, Any] = {
        "board": initial,
        "ends_at": room.ends_at,
        "variant": variant,
    }
    # Both items and team variants use golden apples / item drops.
    if variant in ("items", "team"):
        payload["golden"] = golden
    if teams is not None:
        payload["teams"] = teams
    await broadcast(room, S.msg(S.GAME_START, **payload))

    async def end_after_timeout() -> None:
        try:
            # Sleep until ends_at so the pre-game countdown is included.
            await asyncio.sleep(max(0.0, (room.ends_at or 0) - time.time()))
            await _end_game(room)
        except asyncio.CancelledError:
            pass

    room.timer_task = asyncio.create_task(end_after_timeout())
    # Items/team rounds get a drought-relief ticker (catch-up for stuck units).
    if variant in ("items", "team") and BACKGROUND_LOOPS_ENABLED:
        room.drought_task = asyncio.create_task(_drought_loop(room))
    # Team mode: spin up an AI loop for every team that has a bot member.
    if variant == "team" and BACKGROUND_LOOPS_ENABLED:
        _start_bot_loops(room)


def _drought_grant_pass(room: Room, now: float) -> list[tuple[Any, int, str]]:
    """One drought-relief pass: hand a tier-weighted item to any connected
    unit (team or player) that hasn't cleared in DROUGHT_SECONDS. Mutates
    inventories + drought anchors, returns [(actor, slot, item), ...]. Pure
    state work — the caller owns room.lock / sending."""
    grants: list[tuple[Any, int, str]] = []
    for actor in room.actors():
        if not actor.connected:
            continue
        anchor = actor.drought_anchor or room.started_at or now
        if now - anchor < DROUGHT_SECONDS:
            continue
        free_slot = next(
            (i for i, s in enumerate(actor.inventory) if s is None),
            None,
        )
        # Reset the clock either way so a full inventory doesn't make us
        # re-check (and re-skip) every single tick.
        actor.drought_anchor = now
        if free_slot is None:
            continue
        item = _weighted_drop(_player_tier(room, actor.id))
        actor.inventory[free_slot] = item
        grants.append((actor, free_slot, item))
    return grants


async def _drought_loop(room: Room) -> None:
    """Ticker that catch-up grants items to stuck units (dead boards, attack
    lockdowns, falling behind). Items/team variants only; lives for one
    round. The per-tick state work lives in _drought_grant_pass."""
    try:
        while True:
            await asyncio.sleep(1.0)
            if room.state != "playing":
                return
            now = time.time()
            if room.started_at and now < room.started_at:
                continue  # pre-game countdown — clock hasn't started
            async with room.lock:
                if room.state != "playing":
                    return
                grants = _drought_grant_pass(room, now)
                t_ms = _t_ms(room)
            for actor, slot, item in grants:
                msg = S.msg(
                    S.ITEM_ACQUIRED,
                    player_id=actor.id, slot=slot, item=item, t_ms=t_ms,
                )
                for p in _owner_human_players(room, actor):
                    await send(p, msg)
    except asyncio.CancelledError:
        return


def _owner_human_players(room: Room, actor: Any) -> list[Player]:
    """Human controller(s) behind a board owner — both teammates in team
    mode, or just the player otherwise. Bots are excluded (no ws)."""
    if room.variant == "team":
        return actor.human_members()
    return [actor]


def _actor_by_id(room: Room, owner_id: str | None) -> Any:
    """Resolve a board-owner id back to its actor (Team or Player)."""
    if owner_id is None:
        return None
    if room.variant == "team":
        return room.teams.get(owner_id)
    return room.players.get(owner_id)


# --- AI partner (team mode) -------------------------------------------------

def _bot_delay(room: Room, team: Any, now: float) -> float:
    """Seconds until the bot's next clear — paced to mirror its human
    partner's recent clear cadence so the bot is about as good as them."""
    partner = None
    if team is not None:
        partner = next(
            (m for m in team.members if not m.is_bot and m.connected), None
        )
    base = BOT_DEFAULT_DELAY
    if partner is not None and len(partner.submit_history) >= 2:
        recent = list(partner.submit_history)[-6:]
        intervals = [recent[i] - recent[i - 1] for i in range(1, len(recent))]
        if intervals:
            base = sum(intervals) / len(intervals)
    base = max(BOT_MIN_DELAY, min(BOT_MAX_DELAY, base))
    return base * (0.7 + 0.6 * random.random())


def _start_bot_loops(room: Room) -> None:
    room.bot_tasks = []
    for team in room.teams.values():
        bot = next((m for m in team.members if m.is_bot), None)
        if bot is not None:
            room.bot_tasks.append(
                asyncio.create_task(_bot_loop(room, team.id, bot.id))
            )


async def _bot_loop(room: Room, team_id: str, bot_id: str) -> None:
    try:
        while True:
            delay = _bot_delay(room, room.teams.get(team_id), time.time())
            await asyncio.sleep(delay)
            if room.state != "playing":
                return
            await _bot_step(room, team_id, bot_id)
    except asyncio.CancelledError:
        return


async def _bot_step(room: Room, team_id: str, bot_id: str) -> None:
    """One AI clear on the team's shared board, attributed to the bot. Goes
    through the same scoring core as a human submit (so it can trigger
    golden / combo / drops into the shared inventory). Bots never use items."""
    bcast: dict[str, Any] | None = None
    item_msgs: list[dict[str, Any]] = []
    team: Any = None
    async with room.lock:
        if room.state != "playing":
            return
        team = room.teams.get(team_id)
        if team is None:
            return
        now = time.time()
        if room.started_at and now < room.started_at:
            return  # still in pre-game countdown
        board = room.boards.get(team_id)
        if board is None:
            return
        rect = find_sum10_rect(board)
        if rect is None:
            return  # board has no move right now — try again next tick
        cells = validate_and_clear(board, *rect)
        if cells is None:
            return
        scores, t_ms, combo_after, combo_triggered, item_msgs = _process_clear(
            room, team, cells, now,
        )
        bcast = S.msg(
            S.CLEAR, player_id=team_id, by=bot_id, cells=cells, scores=scores,
            t_ms=t_ms, combo=combo_after, combo_triggered=combo_triggered,
        )
    await broadcast(room, bcast)
    if item_msgs:
        for p in _owner_human_players(room, team):
            for m in item_msgs:
                await send(p, m)


def _process_clear(
    room: Room, actor: Any, cells: list, now: float,
) -> tuple[dict, int, int, bool, list]:
    """Apply a validated clear to its board owner (Player or Team). Caller
    holds room.lock. Mutates score / golden / combo / drops / apples_left and
    appends the replay event. Returns
    (scores, t_ms, combo_after, combo_triggered, item_msgs)."""
    prev_clear_ts = actor.last_score_ts
    actor.score += len(cells)
    actor.last_score_ts = now
    actor.drought_anchor = now  # a clear resets the drought-relief clock
    room.apples_left[actor.id] -= len(cells)
    scores = {a.id: a.score for a in room.actors()}
    t_ms = int((now - room.started_at) * 1000) if room.started_at else 0
    room.events.append({
        "kind": "clear",
        "t_ms": t_ms,
        "player_id": actor.id,   # board owner (team id in team mode)
        "cells": cells,
    })

    item_msgs: list[dict[str, Any]] = []
    combo_after = 0
    combo_triggered = False
    # Three independent triggers. Each grants its own item; a golden pickup
    # grants one item PER golden apple cleared. Capped by free inventory slots.
    if room.variant in ("items", "team"):
        golden_cells = room.golden.get(actor.id) or set()
        consumed = [tuple(cell) for cell in cells if tuple(cell) in golden_cells]
        for cell in consumed:
            golden_cells.discard(cell)

        big_trigger = len(cells) >= BIG_CLEAR_CELLS

        in_window = (
            prev_clear_ts > 0.0
            and (now - prev_clear_ts) <= COMBO_WINDOW_S
        )
        if in_window:
            actor.combo_count += 1
        else:
            actor.combo_count = 1  # start a fresh chain
        combo_trigger = actor.combo_count >= COMBO_THRESHOLD
        if combo_trigger:
            actor.combo_count = 0
            combo_triggered = True
        combo_after = actor.combo_count

        drop_count = (
            len(consumed)
            + (1 if big_trigger else 0)
            + (1 if combo_trigger else 0)
        )
        for _ in range(drop_count):
            free_slot = next(
                (i for i, s in enumerate(actor.inventory) if s is None),
                None,
            )
            if free_slot is None:
                break  # inventory full — remaining drops are forfeited
            tier = _player_tier(room, actor.id)
            item = _weighted_drop(tier)
            actor.inventory[free_slot] = item
            item_msgs.append(S.msg(
                S.ITEM_ACQUIRED,
                player_id=actor.id,
                slot=free_slot,
                item=item,
                t_ms=t_ms,
            ))
    return scores, t_ms, combo_after, combo_triggered, item_msgs


async def _handle_submit(room: Room, player: Player, data: dict[str, Any]) -> None:
    r1, c1, r2, c2 = data.get("r1"), data.get("c1"), data.get("r2"), data.get("c2")
    if None in (r1, c1, r2, c2):
        return
    item_msgs: list[dict[str, Any]] = []
    async with room.lock:
        if room.state != "playing":
            return
        actor = room.actor_for(player.id)
        if actor is None:
            return  # spectator / not seated (e.g. team not yet assigned)
        my_board = room.boards.get(actor.id)
        if my_board is None:
            return
        now = time.time()
        # Pre-game countdown: board is visible but submits are inert.
        if room.started_at is not None and now < room.started_at:
            await send(player, S.msg(S.REJECT, reason="not_started"))
            return
        # Anti-macro gate — runs BEFORE validate_and_clear so a bot can't
        # discover whether its rect was geometrically valid by probing.
        reason = _anti_macro_reject_reason(player, now)
        if reason is not None:
            log.info(
                "anti-macro reject pid=%s reason=%s in1s=%d",
                player.id, reason,
                sum(1 for ts in player.submit_history if now - ts <= 1.0),
            )
            await send(player, S.msg(S.REJECT, reason=reason))
            return
        cells = validate_and_clear(my_board, int(r1), int(c1), int(r2), int(c2))
        if cells is None:
            await send(player, S.msg(S.REJECT, reason="invalid_or_taken"))
            return
        # Record only successful submits in the rate window so legitimate
        # mistypes don't count against the rate cap.
        player.submit_history.append(now)
        scores, t_ms, combo_after, combo_triggered, item_msgs = _process_clear(
            room, actor, cells, now,
        )

    await broadcast(
        room,
        S.msg(
            S.CLEAR,
            player_id=actor.id,   # board owner (team id in team mode)
            by=player.id,         # who actually cleared
            cells=cells,
            scores=scores,
            t_ms=t_ms,
            combo=combo_after,
            combo_triggered=combo_triggered,
        ),
    )
    # Item drops go to the owner's human controller(s) — both teammates in
    # team mode. Opponents only see the inventory count via room state.
    if item_msgs:
        for p in _owner_human_players(room, actor):
            for item_msg in item_msgs:
                await send(p, item_msg)


def _player_tier(room: Room, owner_id: str) -> str:
    """Bucket the board owner (team or player) into top / middle / bottom by
    current score. Single-unit rooms always return "middle". Two units map
    rank-1 → top, rank-2 → bottom; 3+ split into rough thirds."""
    actors = sorted(
        room.actors(),
        key=lambda a: (-a.score, a.last_score_ts or float("inf")),
    )
    n = len(actors)
    if n <= 1:
        return "middle"
    idx = next((i for i, a in enumerate(actors) if a.id == owner_id), 0)
    if n == 2:
        return "top" if idx == 0 else "bottom"
    if idx * 3 < n:
        return "top"
    if idx * 3 < 2 * n:
        return "middle"
    return "bottom"


def _weighted_drop(tier: str) -> str:
    """Pick an item kind using the tier-specific weight table."""
    weights = ITEM_DROP_WEIGHTS.get(tier) or ITEM_DROP_WEIGHTS["middle"]
    items = list(weights.keys())
    ws = list(weights.values())
    return random.choices(items, weights=ws, k=1)[0]


def _pick_attack_target(room: Room, attacker_id: str) -> str | None:
    """Top-3 by score among OTHER connected units (teams/players, attacker's
    own unit excluded) → random one. attacker_id is an owner id."""
    candidates = [
        a for a in room.actors()
        if a.id != attacker_id and a.connected
    ]
    if not candidates:
        return None
    candidates.sort(
        key=lambda a: (-a.score, a.last_score_ts or float("inf")),
    )
    pool = candidates[:3]
    return random.choice(pool).id


async def _handle_use_item(
    room: Room, player: Player, data: dict[str, Any]
) -> None:
    slot = data.get("slot")
    if not isinstance(slot, int) or slot < 0:
        return
    now = time.time()
    payload: dict[str, Any] = {}
    async with room.lock:
        if room.state != "playing":
            return
        if room.started_at is not None and now < room.started_at:
            return  # silently ignore during countdown
        actor = room.actor_for(player.id)
        if actor is None or slot >= len(actor.inventory):
            return
        item = actor.inventory[slot]
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
        blocked = False
        cleansed: list[str] = []
        # Attack items targeting an opponent: pick a target, then let the
        # target's shield block the strike (the attacker's slot still
        # burns). All three share this shape, only the deadline attr differs.
        ATTACK_DEADLINE = {
            "blind": ("blind_until", EFFECT_BLIND),
            "overload": ("overload_until", EFFECT_OVERLOAD),
            "freeze": ("freeze_until", EFFECT_FREEZE),
        }
        if item == "hint":
            pair = find_sum10_pair(room.boards.get(actor.id, []))
            payload["hint"] = [{"r": r, "c": c} for (r, c) in (pair or [])]
            target_id = actor.id
            until = now + EFFECT_HINT
        elif item in ATTACK_DEADLINE:
            target_id = _pick_attack_target(room, actor.id)
            target = _actor_by_id(room, target_id) if target_id else None
            if target is None:
                return
            attr, dur = ATTACK_DEADLINE[item]
            if target.shield_until > now:
                blocked = True
                until = now
            else:
                deadline = now + dur
                setattr(target, attr, deadline)
                until = deadline
        elif item == "shuffle":
            # Self-shuffle — re-rolls the owner's own remaining apples.
            target_id = actor.id
            target_board = room.boards.get(actor.id)
            if target_board is None:
                return
            shuffle_remaining(target_board)
            until = now  # one-shot effect
        elif item == "shield":
            target_id = actor.id
            # Stacking shields EXTEND rather than overwrite: a second shield
            # used while one is active adds another full duration on top.
            actor.shield_until = max(actor.shield_until, now) + EFFECT_SHIELD
            until = actor.shield_until
            # Shield also cleanses any active attack effect on the owner.
            for eff, attr in (
                ("blind", "blind_until"),
                ("overload", "overload_until"),
                ("freeze", "freeze_until"),
            ):
                if getattr(actor, attr) > now:
                    setattr(actor, attr, 0.0)
                    cleansed.append(eff)
        else:
            return
        # Consume the slot
        actor.inventory[slot] = None
        payload["target_id"] = target_id
        t_ms = _t_ms(room)
        room.events.append({
            "kind": "item_used",
            "t_ms": t_ms,
            "by": player.id,
            "item": item,
            "target_id": target_id,
            "blocked": blocked,
        })
        owner_id = actor.id
        for eff in cleansed:
            # Record each cleansed effect so replay shows it ending here.
            room.events.append({
                "kind": "effect_end",
                "t_ms": t_ms,
                "target_id": owner_id,
                "effect": eff,
            })

    used_msg = S.msg(
        S.ITEM_USED,
        by=player.id,
        item=item,
        target_id=payload.get("target_id"),
        slot=slot,
        t_ms=t_ms,
        blocked=blocked,
    )
    await broadcast(room, used_msg)

    for eff in cleansed:
        await broadcast(
            room,
            S.msg(S.EFFECT_END, target_id=owner_id, effect=eff, t_ms=t_ms),
        )

    if blocked:
        # Attack fizzled — slot was consumed, but no effect_start should
        # fire and no follow-up tasks are scheduled.
        return

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


async def _handle_discard_item(
    room: Room, player: Player, data: dict[str, Any]
) -> None:
    """Throw away an inventory slot without using its effect.

    Operates on the OWNER's inventory (the shared team pool in team mode,
    else the player's). In team mode the ack goes to both teammates so the
    shared inventory view stays in sync; opponents see nothing either way.
    """
    slot = data.get("slot")
    if not isinstance(slot, int) or slot < 0:
        return
    async with room.lock:
        if room.state != "playing":
            return
        actor = room.actor_for(player.id)
        if actor is None or slot >= len(actor.inventory):
            return
        if actor.inventory[slot] is None:
            return
        actor.inventory[slot] = None
    for p in _owner_human_players(room, actor):
        await send(p, S.msg(S.ITEM_DISCARDED, slot=slot))


async def _clear_effect_after(
    room: Room, target_id: str, effect: str, delay: float
) -> None:
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    if room.state != "playing":
        return
    attr = EFFECT_DEADLINE_ATTR.get(effect)
    async with room.lock:
        if room.state != "playing":
            return
        # If the effect was re-applied / extended (e.g. a second shield),
        # its live deadline now sits in the future — defer to the later
        # timer instead of ending it early.
        target = _actor_by_id(room, target_id)
        if target is not None and attr is not None:
            now = time.time()
            deadline = getattr(target, attr, 0.0)
            if deadline > now + 0.05:
                asyncio.create_task(
                    _clear_effect_after(room, target_id, effect, deadline - now)
                )
                return
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
        drought = room.drought_task
        room.drought_task = None
        room.winner_id = room.determine_winner()
        scores = {a.id: a.score for a in room.actors()}
        bots = list(room.bot_tasks)
        room.bot_tasks = []
        _award_medals(room)
    # Cancel the timeout task only if we're ending early (not from inside it).
    # Cancelling the current task would interrupt the broadcast below.
    current = asyncio.current_task()
    if timer is not None and timer is not current and not timer.done():
        timer.cancel()
    if drought is not None and drought is not current and not drought.done():
        drought.cancel()
    for bt in bots:
        if bt is not current and not bt.done():
            bt.cancel()
    await broadcast(
        room,
        S.msg(S.GAME_END, scores=scores, winner_id=room.winner_id),
    )


def _award_medals(room: Room) -> None:
    """Friend rooms only: bump top-3 medal counts. Over actors — in team
    mode each medal goes to both human members of the team. Units that
    scored 0 get nothing; 2-unit rooms get no bronze."""
    if room.mode != "friend":
        return
    scored = sorted(
        room.actors(),
        key=lambda a: (-a.score, a.last_score_ts or float("inf")),
    )
    kinds = ("gold", "silver", "bronze")
    for i, a in enumerate(scored[:3]):
        if a.score <= 0:
            continue
        recipients = _owner_human_players(room, a)
        for p in recipients:
            p.medals[kinds[i]] = p.medals.get(kinds[i], 0) + 1


async def _handle_kick(room: Room, target_id: str, manager: RoomManager) -> None:
    """Host removes + bans a player from the lobby. Note: with no accounts,
    the ban only blocks the *same* session (reconnect / lingering id) from
    re-entering — a fresh link click mints a new id and can rejoin. That's
    the inherent ceiling of moderation in an anonymous game."""
    async with room.lock:
        target = room.players.get(target_id)
        if target is None:
            return
        room.banned.add(target_id)
        room.players.pop(target_id, None)
        # Drop any stale per-player game state defensively (none in waiting).
        room.boards.pop(target_id, None)
        room.golden.pop(target_id, None)
        room.apples_left.pop(target_id, None)
        target_ws = target.ws
        # Sever our claim on the slot so the kicked session's own cleanup
        # won't re-broadcast peer_left or otherwise fight us.
        target.ws = None
        target.connected = False
    if target_ws is not None:
        try:
            await target_ws.send_json(S.msg(S.KICKED))
            await target_ws.close()
        except Exception:  # noqa: BLE001
            pass
    await broadcast(room, S.msg(S.PEER_LEFT, player_id=target_id))


async def _handle_rematch(room: Room, player: Player) -> None:
    async with room.lock:
        if room.state != "finished":
            return
        # Random rooms intentionally don't rematch in place — the client
        # re-enters matchmaking from scratch so each player can be paired
        # with a fresh opponent set.
        if room.mode == "random":
            return
        # Only host (friend mode) can trigger rematch
        if room.mode == "friend" and player.id != room.host_id:
            return
        if room.mode == "friend":
            # Sweep ghosts: players still in the roster who never reconnected
            # after dropping during the last round. The lobby for the next
            # round should show only currently-present players.
            ghosts = [pid for pid, p in room.players.items() if not p.connected]
            for pid in ghosts:
                room.players.pop(pid, None)
        room.reset_for_rematch()
        if room.mode == "friend":
            # Promote every connected spectator (mid-round watcher) into a
            # real player for the next round. We deliberately ignore capacity
            # here: a watcher who was already present shouldn't be left in a
            # half-state, and exceeding the soft cap by a few is harmless
            # (set_capacity clamps up to the live player count anyway).
            for sid, spec in list(room.spectators.items()):
                room.spectators.pop(sid, None)
                if spec.connected:
                    room.players[sid] = spec
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
        # A spectator leaving just drops out of the watch list — no
        # peer_left, no cleanup scheduling (they were never a player).
        if player.id in room.spectators and player.id not in room.players:
            room.spectators.pop(player.id, None)
            return
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
    # reconnect. Game does NOT end on disconnect. (Bots never count as a
    # live connection, so a room of only-bots still cleans up.)
    await broadcast(room, S.msg(S.PEER_DISCONNECTED, player_id=player.id))

    async with room.lock:
        all_disc = all(
            not p.connected for p in room.players.values() if not p.is_bot
        )
    if all_disc:
        _schedule_room_cleanup(room, manager)


def _schedule_room_cleanup(room: Room, manager: RoomManager) -> None:
    """If everyone is disconnected, wipe the room after DISCONNECT_GRACE."""
    if room.cleanup_task and not room.cleanup_task.done():
        return  # already scheduled
    # Stop the drought ticker + AI loops while the room sits empty awaiting
    # cleanup — nobody is connected. They're restarted on reconnect.
    if room.drought_task and not room.drought_task.done():
        room.drought_task.cancel()
        room.drought_task = None
    for bt in room.bot_tasks:
        if not bt.done():
            bt.cancel()
    room.bot_tasks = []

    async def cleanup_after() -> None:
        try:
            await asyncio.sleep(DISCONNECT_GRACE)
            async with room.lock:
                still_all_disc = all(
                    not p.connected for p in room.players.values() if not p.is_bot
                )
            if not still_all_disc:
                return
            # End game if still playing, then drop the room
            if room.state == "playing":
                await _end_game(room)
            await manager.remove(room.id)
        except asyncio.CancelledError:
            pass

    room.cleanup_task = asyncio.create_task(cleanup_after())
