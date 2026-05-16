"""Shared pytest fixtures."""
import pytest


@pytest.fixture(autouse=True)
def _zero_countdown(monkeypatch):
    """Disable the 3-2-1 pre-game countdown for all tests.

    The countdown is a UX flourish on top of normal play; tests assert
    against game mechanics and would have to wait 3 extra seconds per
    round otherwise. Setting started_at = now keeps legacy timing.
    """
    import app.game.room as room_mod
    monkeypatch.setattr(room_mod, "COUNTDOWN_SECS", 0.0, raising=True)
