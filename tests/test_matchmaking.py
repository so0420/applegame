import asyncio

import pytest

from app.matchmaking import Matchmaker
from app.ws.manager import RoomManager, make_player


@pytest.mark.asyncio
async def test_first_player_gets_future_second_gets_room():
    mgr = RoomManager()
    mm = Matchmaker(mgr)

    p1 = make_player("alice")
    p2 = make_player("bob")

    r1 = await mm.enqueue(p1)
    assert isinstance(r1, asyncio.Future)
    assert mm.position(p1.id) == 1

    r2 = await mm.enqueue(p2)
    # second one matches immediately and returns Room
    from app.game.room import Room
    assert isinstance(r2, Room)
    assert p1.id in r2.players
    assert p2.id in r2.players

    # the first player's future is now resolved with the same room
    resolved = await asyncio.wait_for(r1, timeout=0.5)
    assert resolved is r2


@pytest.mark.asyncio
async def test_cancel_removes_from_queue():
    mgr = RoomManager()
    mm = Matchmaker(mgr)

    p1 = make_player("alice")
    fut = await mm.enqueue(p1)
    assert isinstance(fut, asyncio.Future)

    await mm.cancel(p1.id)
    assert mm.position(p1.id) == 0
    assert fut.cancelled()
