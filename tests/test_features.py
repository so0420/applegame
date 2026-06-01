"""Tests for the newer feature batch: shield stacking, drought relief,
spectators, host kick/rename, and the feedback endpoint."""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.game.board import COLS, ROWS
from app.main import app


def _drain_until(ws, mtype, limit=12):
    for _ in range(limit):
        m = ws.receive_json()
        if m["type"] == mtype:
            return m
    raise AssertionError(f"did not see {mtype}")


def _friend_lobby(client):
    """Host + guest sitting in a friend lobby (waiting). Returns the open
    ws contexts/handles + ids + room. Caller closes the contexts."""
    host_ctx = client.websocket_connect("/ws")
    host = host_ctx.__enter__()
    host.send_json({"type": "hello", "intent": "create", "nickname": "host"})
    host_joined = host.receive_json()
    room_id = host_joined["room"]["id"]
    host_id = host_joined["player_id"]
    guest_ctx = client.websocket_connect("/ws")
    guest = guest_ctx.__enter__()
    guest.send_json({"type": "hello", "intent": "join", "code": room_id, "nickname": "guest"})
    guest_joined = guest.receive_json()
    guest_id = guest_joined["player_id"]
    host.receive_json()  # peer_joined
    from app.main import manager
    room = manager.get(room_id)
    return host_ctx, guest_ctx, host, guest, host_id, guest_id, room_id, room


def _start_items_game(client):
    host_ctx = client.websocket_connect("/ws")
    host = host_ctx.__enter__()
    host.send_json({"type": "hello", "intent": "create"})
    host_joined = host.receive_json()
    room_id = host_joined["room"]["id"]
    host_id = host_joined["player_id"]
    host.send_json({"type": "set_variant", "variant": "items"})
    host.receive_json()  # variant_changed
    guest_ctx = client.websocket_connect("/ws")
    guest = guest_ctx.__enter__()
    guest.send_json({"type": "hello", "intent": "join", "code": room_id})
    guest_joined = guest.receive_json()
    guest_id = guest_joined["player_id"]
    host.receive_json()  # peer_joined
    host.send_json({"type": "start"})
    host.receive_json()
    guest.receive_json()
    from app.main import manager
    room = manager.get(room_id)
    return host_ctx, guest_ctx, host, guest, host_id, guest_id, room_id, room


# ------------------------------------------------------------------
# Shield stacking
# ------------------------------------------------------------------

def test_shield_stacking_extends_duration():
    """Using shield while a shield is active EXTENDS the deadline by another
    full duration rather than overwriting it."""
    from app.game.room import EFFECT_SHIELD
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _start_items_game(client)
    try:
        hp = room.players[host_id]
        hp.inventory[0] = "shield"
        host.send_json({"type": "use_item", "slot": 0})
        _drain_until(host, "effect_start")
        first_until = hp.shield_until
        assert first_until > time.time()
        # Second shield while the first is active.
        hp.inventory[1] = "shield"
        host.send_json({"type": "use_item", "slot": 1})
        _drain_until(host, "effect_start")
        # Extended by (close to) another full duration, not reset to now+dur.
        assert hp.shield_until > first_until + EFFECT_SHIELD * 0.8
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


# ------------------------------------------------------------------
# Drought relief
# ------------------------------------------------------------------

def test_drought_relief_grants_item(monkeypatch):
    """A player who goes DROUGHT_SECONDS without clearing is handed an item."""
    import app.ws.handlers as handlers_mod
    monkeypatch.setattr(handlers_mod, "DROUGHT_SECONDS", 0.4)
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _start_items_game(client)
    try:
        # Don't clear anything — within ~1 tick the relief loop should fire.
        acq = _drain_until(host, "item_acquired", limit=4)
        assert acq["player_id"] == host_id
        assert acq["item"] in (
            "hint", "shuffle", "blind", "overload", "freeze", "shield",
        )
        assert any(s is not None for s in room.players[host_id].inventory)
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


# ------------------------------------------------------------------
# Host kick / rename
# ------------------------------------------------------------------

def test_host_kick_removes_and_bans_player():
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _friend_lobby(client)
    try:
        host.send_json({"type": "kick", "player_id": guest_id})
        # Guest is told they were kicked.
        kicked = _drain_until(guest, "kicked")
        assert kicked["type"] == "kicked"
        # Host sees peer_left.
        left = _drain_until(host, "peer_left")
        assert left["player_id"] == guest_id
        assert guest_id not in room.players
        assert guest_id in room.banned
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_non_host_cannot_kick():
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _friend_lobby(client)
    try:
        # Guest tries to kick the host — must be ignored.
        guest.send_json({"type": "kick", "player_id": host_id})
        guest.send_json({"type": "rename", "nickname": "stillhere"})
        msg = guest.receive_json()
        assert msg["type"] == "renamed"
        assert host_id in room.players
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_host_rename_changes_other_player():
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _friend_lobby(client)
    try:
        host.send_json({"type": "host_rename", "player_id": guest_id, "nickname": "RenamedGuest"})
        host_msg = _drain_until(host, "renamed")
        guest_msg = _drain_until(guest, "renamed")
        assert host_msg["player_id"] == guest_id
        assert host_msg["nickname"] == "RenamedGuest"
        assert guest_msg["nickname"] == "RenamedGuest"
        assert room.players[guest_id].nickname == "RenamedGuest"
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


# ------------------------------------------------------------------
# Spectator
# ------------------------------------------------------------------

def test_join_midgame_becomes_spectator():
    client = TestClient(app)
    h_ctx, g_ctx, host, guest, host_id, guest_id, room_id, room = _start_items_game(client)
    spec_ctx = client.websocket_connect("/ws")
    spec = spec_ctx.__enter__()
    try:
        spec.send_json({"type": "hello", "intent": "join", "code": room_id})
        snap = spec.receive_json()
        assert snap["type"] == "spectate"
        assert snap["state"] == "playing"
        assert "boards" in snap and "events" in snap
        spec_id = snap["player_id"]
        assert spec_id in room.spectators
        assert spec_id not in room.players
    finally:
        spec_ctx.__exit__(None, None, None)
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_spectator_promoted_to_player_on_rematch(monkeypatch):
    import app.game.room as room_mod
    import app.ws.handlers as handlers_mod
    monkeypatch.setattr(room_mod, "GAME_DURATION", 0.3)
    monkeypatch.setattr(handlers_mod, "GAME_DURATION", 0.3)
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()       # joined
            host.receive_json()        # peer_joined
            host.send_json({"type": "start"})
            host.receive_json()        # game_start
            guest.receive_json()       # game_start
            host.receive_json()        # game_end (0.3s timer)
            guest.receive_json()       # game_end
            # Spectator joins the now-finished room.
            with client.websocket_connect("/ws") as spec:
                spec.send_json({"type": "hello", "intent": "join", "code": room_id})
                snap = spec.receive_json()
                assert snap["type"] == "spectate"
                spec_id = snap["player_id"]
                # Host rematch → spectator promoted into the lobby roster.
                host.send_json({"type": "rematch"})
                reset = _drain_until(spec, "room_reset")
                ids = [p["id"] for p in reset["room"]["players"]]
                assert spec_id in ids
                from app.main import manager
                room = manager.get(room_id)
                assert spec_id in room.players
                assert spec_id not in room.spectators


# ------------------------------------------------------------------
# Feedback endpoint
# ------------------------------------------------------------------

def test_feedback_delivers_to_discord(monkeypatch):
    """A valid submission is delivered to Discord and returns ok:true."""
    import app.feedback as fb
    captured = []

    async def fake_post(url, message, contact, ip):
        captured.append((url, message, contact))
        return True

    monkeypatch.setattr(fb, "_post_to_discord", fake_post)
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://example.test/hook")
    monkeypatch.setattr(fb, "_ip_hits", {})
    client = TestClient(app)
    resp = client.post(
        "/api/feedback",
        json={"message": "버그 제보합니다 테스트", "contact": "me@example.com"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert captured and "버그 제보" in captured[0][1]


def test_feedback_delivery_failure_surfaces(monkeypatch):
    """When delivery fails (e.g. no webhook URL) the user sees a 502 error,
    not a silent success."""
    import app.feedback as fb
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(fb, "_ip_hits", {})
    client = TestClient(app)
    resp = client.post("/api/feedback", json={"message": "전달 실패 시나리오"})
    assert resp.status_code == 502
    assert resp.json()["ok"] is False


def test_feedback_rejects_short_message(monkeypatch):
    import app.feedback as fb
    monkeypatch.setattr(fb, "_ip_hits", {})
    client = TestClient(app)
    resp = client.post("/api/feedback", json={"message": "x"})
    assert resp.status_code == 400
    assert resp.json()["ok"] is False


def test_feedback_rejects_oversized_body(monkeypatch):
    """A huge body is rejected (413) before it is parsed into memory."""
    import app.feedback as fb
    monkeypatch.setattr(fb, "_ip_hits", {})
    client = TestClient(app)
    huge = "x" * (20 * 1024)
    resp = client.post("/api/feedback", json={"message": huge})
    assert resp.status_code == 413
    assert resp.json()["ok"] is False
