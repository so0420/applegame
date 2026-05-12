import asyncio

import pytest

from app.matchmaking import Matchmaker
from app.ws.manager import RoomManager, make_player


async def _noop_start(_room):
    pass


async def _noop_broadcast(*_args, **_kwargs):
    pass


@pytest.mark.asyncio
async def test_first_player_creates_pending_room_no_countdown():
    mgr = RoomManager()
    mm = Matchmaker(mgr, on_start=_noop_start, broadcast=_noop_broadcast)
    p1 = make_player("alice")

    room, deadline = await mm.enqueue(p1)
    assert room.mode == "random"
    assert p1.id in room.players
    assert room.capacity == Matchmaker.MAX_PLAYERS
    assert deadline is None  # countdown only starts at 2 players


@pytest.mark.asyncio
async def test_second_player_joins_same_room_starts_countdown():
    mgr = RoomManager()
    mm = Matchmaker(mgr, on_start=_noop_start, broadcast=_noop_broadcast)
    p1 = make_player("alice")
    p2 = make_player("bob")

    room1, _ = await mm.enqueue(p1)
    room2, deadline = await mm.enqueue(p2)
    assert room1 is room2
    assert {p1.id, p2.id} <= set(room2.players.keys())
    assert deadline is not None  # countdown armed
    # Cleanup the spawned countdown task
    await mm.player_left(p2.id, room2)
    await mm.player_left(p1.id, room1)


@pytest.mark.asyncio
async def test_filling_to_max_short_circuits():
    mgr = RoomManager()
    mm = Matchmaker(mgr, on_start=_noop_start, broadcast=_noop_broadcast)
    players = [make_player(f"p{i}") for i in range(Matchmaker.MAX_PLAYERS)]
    last_deadline = None
    for p in players:
        _, last_deadline = await mm.enqueue(p)
    # Once full the deadline collapses to WAIT_WHEN_FULL.
    import time
    remaining_ms = last_deadline - int(time.time() * 1000)
    assert remaining_ms <= Matchmaker.WAIT_WHEN_FULL * 1000 + 200


@pytest.mark.asyncio
async def test_player_left_below_min_cancels_countdown():
    mgr = RoomManager()
    mm = Matchmaker(mgr, on_start=_noop_start, broadcast=_noop_broadcast)
    p1 = make_player("alice")
    p2 = make_player("bob")
    room, _ = await mm.enqueue(p1)
    room, deadline = await mm.enqueue(p2)
    assert deadline is not None
    # Player 2 leaves — the room drops back to 1 player, countdown cancels
    room.players.pop(p2.id, None)
    await mm.player_left(p2.id, room)
    assert mm.deadline_ms is None
