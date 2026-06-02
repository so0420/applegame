"""Shared pytest fixtures."""
import contextlib

import pytest


@pytest.fixture(autouse=True)
def _single_ws_loop(monkeypatch):
    """Run all of a test's TestClient connections on ONE event loop.

    Starlette's TestClient starts a fresh blocking portal (own thread + own
    asyncio loop) per connection. Our server shares mutable room state across
    connections and guards it with an asyncio.Lock; an asyncio.Lock used from
    two different loops hangs under contention, which made multi-connection
    tests (reconnect / disconnect broadcasts) flaky. Production runs every
    connection on a single loop — so we make the tests match by handing every
    `_portal_factory()` call the same shared portal.
    """
    import anyio.from_thread
    import starlette.testclient as stc

    holder = {}

    @contextlib.contextmanager
    def shared_portal_factory(self):
        if "portal" not in holder:
            cm = anyio.from_thread.start_blocking_portal(**self.async_backend)
            holder["cm"] = cm
            holder["portal"] = cm.__enter__()
        yield holder["portal"]   # reused across connections; not closed here

    monkeypatch.setattr(stc.TestClient, "_portal_factory", shared_portal_factory, raising=True)
    yield
    cm = holder.get("cm")
    if cm is not None:
        try:
            cm.__exit__(None, None, None)
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _zero_countdown(monkeypatch):
    """Disable the 3-2-1 pre-game countdown for all tests.

    The countdown is a UX flourish on top of normal play; tests assert
    against game mechanics and would have to wait 3 extra seconds per
    round otherwise. Setting started_at = now keeps legacy timing.
    """
    import app.game.room as room_mod
    monkeypatch.setattr(room_mod, "COUNTDOWN_SECS", 0.0, raising=True)


@pytest.fixture(autouse=True)
def _quiet_background_loops(monkeypatch):
    """Disable the periodic drought-relief / AI-bot loops by default.

    TestClient runs each WebSocket connection in its own event loop/thread;
    a timer-driven broadcast from one connection's loop can race cross-loop
    delivery to another connection and make multi-connection tests flaky.
    Production uses a single event loop, so this is purely a test artifact.
    Tests that exercise those loops re-enable them explicitly.
    """
    import app.ws.handlers as handlers_mod
    monkeypatch.setattr(
        handlers_mod, "BACKGROUND_LOOPS_ENABLED", False, raising=True,
    )


@pytest.fixture(autouse=True)
def _isolate_manager():
    """Wipe the shared module-level room registry between tests.

    `app.main.manager` is a process singleton, so rooms (and their
    background drought / bot / cleanup loops) created by one test would
    otherwise linger into the next and cause cross-test timing races.
    Clearing the registry + matchmaker pending slots keeps each test
    starting from a clean slate.
    """
    yield
    try:
        from app.main import manager, matchmaker
        manager.rooms.clear()
        for slot in matchmaker._pending.values():
            slot["room_id"] = None
            slot["task"] = None
            slot["deadline_ms"] = None
    except Exception:
        pass
