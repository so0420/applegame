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

def test_drought_grant_pass_grants_when_stuck():
    """A unit past DROUGHT_SECONDS with a free slot gets a tier-weighted item;
    a unit inside the window does not. Pure pass — no timer loop / WS."""
    from app.ws.handlers import _drought_grant_pass
    from app.game.room import Room, Player, ITEM_KINDS
    room = Room(id="x", mode="random", variant="items")
    stuck = Player(id="stuck", nickname="stuck")
    fresh = Player(id="fresh", nickname="fresh")
    room.players = {"stuck": stuck, "fresh": fresh}
    room.started_at = 100.0
    stuck.drought_anchor = 100.0   # last cleared at round start
    fresh.drought_anchor = 119.0   # cleared recently

    grants = _drought_grant_pass(room, 120.0)  # 20s in
    granted_ids = {a.id for a, _, _ in grants}
    assert "stuck" in granted_ids       # 20s ≥ 15s → relief
    assert "fresh" not in granted_ids   # 1s < 15s → no relief
    actor, slot, item = next(g for g in grants if g[0].id == "stuck")
    assert item in ITEM_KINDS
    assert stuck.inventory[slot] == item
    assert stuck.drought_anchor == 120.0  # clock reset


def test_drought_grant_pass_skips_full_inventory():
    from app.ws.handlers import _drought_grant_pass
    from app.game.room import Room, Player
    room = Room(id="x", mode="random", variant="items")
    p = Player(id="p", nickname="p", inventory=["hint", "shield", "blind"])  # full (3)
    room.players = {"p": p}
    room.started_at = 100.0
    p.drought_anchor = 100.0
    grants = _drought_grant_pass(room, 130.0)
    assert grants == []                 # no free slot → nothing granted
    assert p.drought_anchor == 130.0    # but clock still reset (no re-spin)


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


# ------------------------------------------------------------------
# Team mode — pure model tests (no WS / no async loops)
# ------------------------------------------------------------------

def _team_room(n_humans):
    from app.game.room import Room, Player
    room = Room(id="TROOM", mode="friend", variant="team")
    for i in range(n_humans):
        room.players[f"p{i}"] = Player(id=f"p{i}", nickname=f"p{i}")
    room.start()
    return room


def test_team_formation_pairs_players():
    room = _team_room(4)
    assert len(room.teams) == 2
    # Every human is assigned to exactly one team.
    humans = {f"p{i}" for i in range(4)}
    assert humans <= set(room.team_of.keys())
    assert all(room.team_of[h] in room.teams for h in humans)
    # Boards/golden/apples are keyed by team, not player.
    assert set(room.boards.keys()) == set(room.teams.keys())
    assert set(room.golden.keys()) == set(room.teams.keys())
    for t in room.teams.values():
        assert len(t.members) == 2
        assert len(t.inventory) == 4  # shared team pool of 4
        assert all(not m.is_bot for m in t.members)  # 4 humans → no bot


def test_team_formation_odd_count_adds_one_bot():
    room = _team_room(5)
    assert len(room.teams) == 3
    bots = [p for p in room.players.values() if p.is_bot]
    assert len(bots) == 1
    bot = bots[0]
    tid = room.team_of[bot.id]
    members = room.teams[tid].members
    assert sum(1 for m in members if m.is_bot) == 1
    assert sum(1 for m in members if not m.is_bot) == 1
    # Bot is never shown in the lobby roster.
    assert all(not p["is_bot"] for p in room.public()["players"])


def test_team_rematch_disbands_and_drops_bot():
    room = _team_room(5)
    assert any(p.is_bot for p in room.players.values())
    room.reset_for_rematch()
    assert not room.teams
    assert not room.team_of
    assert not any(p.is_bot for p in room.players.values())  # bot dropped


def test_team_determine_winner_is_a_team_id():
    room = _team_room(4)
    tids = list(room.teams)
    room.teams[tids[0]].score = 30
    room.teams[tids[1]].score = 10
    assert room.determine_winner() == tids[0]


def test_find_sum10_rect_finds_valid_move():
    import random
    from app.game.board import find_sum10_rect, ROWS, COLS
    board = [[1] * COLS for _ in range(ROWS)]  # 1s → many sum-10 runs
    rect = find_sum10_rect(board, random.Random(3))
    assert rect is not None
    r1, c1, r2, c2 = rect
    s = sum(board[r][c] for r in range(r1, r2 + 1) for c in range(c1, c2 + 1))
    assert s == 10


def test_find_sum10_rect_none_when_no_move():
    import random
    from app.game.board import find_sum10_rect, ROWS, COLS
    board = [[9] * COLS for _ in range(ROWS)]  # 9 alone <10, 9+9=18 >10 → no move
    assert find_sum10_rect(board, random.Random(3)) is None


def test_bot_delay_mirrors_partner_pace():
    from app.ws.handlers import _bot_delay, BOT_MIN_DELAY, BOT_MAX_DELAY
    from app.game.room import Team, Player
    partner = Player(id="h", nickname="h")
    # Partner cleared at a ~2.0s cadence.
    for t in (100.0, 102.0, 104.0, 106.0):
        partner.submit_history.append(t)
    team = Team(id="T1", members=[partner, Player(id="b", nickname="b", is_bot=True)])
    # 50 samples — every one inside the clamp band and near the 2.0s base.
    delays = [_bot_delay(None, team, 110.0) for _ in range(50)]
    assert all(BOT_MIN_DELAY <= d <= BOT_MAX_DELAY for d in delays)
    assert 1.2 <= sum(delays) / len(delays) <= 3.5  # tracks the ~2.0s pace


def test_player_tier_over_teams():
    from app.ws.handlers import _player_tier
    from app.game.room import Room, Team
    room = Room(id="x", mode="friend", variant="team")
    room.teams = {
        "T1": Team(id="T1", score=20),
        "T2": Team(id="T2", score=5),
    }
    assert _player_tier(room, "T1") == "top"
    assert _player_tier(room, "T2") == "bottom"


# ------------------------------------------------------------------
# Team mode — WS integration (read only the actor's own messages so the
# assertions don't depend on cross-connection delivery timing)
# ------------------------------------------------------------------

def _start_team_game(client, n=4):
    host_ctx = client.websocket_connect("/ws")
    host = host_ctx.__enter__()
    host.send_json({"type": "hello", "intent": "create"})
    hj = host.receive_json()
    room_id = hj["room"]["id"]
    host.send_json({"type": "set_variant", "variant": "team"})
    host.receive_json()  # variant_changed
    ctxs = [host_ctx]
    wss = [host]
    ids = [hj["player_id"]]
    for _ in range(n - 1):
        c = client.websocket_connect("/ws")
        w = c.__enter__()
        w.send_json({"type": "hello", "intent": "join", "code": room_id})
        ids.append(w.receive_json()["player_id"])
        host.receive_json()  # peer_joined on host
        ctxs.append(c)
        wss.append(w)
    host.send_json({"type": "start"})
    host.receive_json()  # game_start on host
    from app.main import manager
    return ctxs, wss, ids, manager.get(room_id)


def test_team_submit_scores_the_team():
    client = TestClient(app)
    ctxs, wss, ids, room = _start_team_game(client, 4)
    try:
        sub, sub_id = wss[1], ids[1]
        tid = room.team_of[sub_id]
        team = room.teams[tid]
        room.boards[tid] = [[1] * COLS for _ in range(ROWS)]
        room.boards[tid][0][0] = 5
        room.boards[tid][0][1] = 5
        team.score = 0
        sub.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(sub, "clear")
        assert clear["player_id"] == tid     # board owner = team
        assert clear["by"] == sub_id          # acting player
        assert team.score == 2
        assert len(team.inventory) == 4
    finally:
        for c in ctxs:
            c.__exit__(None, None, None)


def test_team_discard_clears_shared_slot():
    """Discard works on the shared 4-slot team inventory (incl. slot 3), and
    the ack reaches the discarding teammate."""
    client = TestClient(app)
    ctxs, wss, ids, room = _start_team_game(client, 4)
    try:
        sub, sub_id = wss[1], ids[1]
        team = room.teams[room.team_of[sub_id]]
        team.inventory = ["hint", "shield", "blind", "freeze"]  # full 4
        sub.send_json({"type": "discard_item", "slot": 3})
        assert _drain_until(sub, "item_discarded")["slot"] == 3
        assert team.inventory[3] is None
        sub.send_json({"type": "discard_item", "slot": 0})
        assert _drain_until(sub, "item_discarded")["slot"] == 0
        assert team.inventory[0] is None
    finally:
        for c in ctxs:
            c.__exit__(None, None, None)


def test_team_min_players_enforced():
    client = TestClient(app)
    ctxs = []
    try:
        host_ctx = client.websocket_connect("/ws")
        host = host_ctx.__enter__()
        ctxs.append(host_ctx)
        host.send_json({"type": "hello", "intent": "create"})
        rid = host.receive_json()["room"]["id"]
        host.send_json({"type": "set_variant", "variant": "team"})
        host.receive_json()
        # Only 3 humans total (host + 2) — below the 4 needed for teams.
        for _ in range(2):
            c = client.websocket_connect("/ws")
            w = c.__enter__()
            ctxs.append(c)
            w.send_json({"type": "hello", "intent": "join", "code": rid})
            w.receive_json()
            host.receive_json()  # peer_joined
        host.send_json({"type": "start"})
        msg = _drain_until(host, "error")
        assert msg["code"] == "not_ready"
    finally:
        for c in ctxs:
            c.__exit__(None, None, None)
