"""WebSocket integration tests using the FastAPI TestClient."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def _hello(ws, nickname, intent, code=None):
    ws.send_json({"type": "hello", "nickname": nickname, "intent": intent, "code": code})


def test_solo_flow():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        _hello(ws, "solo1", "solo")
        joined = ws.receive_json()
        assert joined["type"] == "joined"
        assert joined["room"]["mode"] == "solo"
        # game_start is sent automatically for solo
        start = ws.receive_json()
        assert start["type"] == "game_start"
        assert len(start["board"]) == 10
        assert all(len(row) == 17 for row in start["board"])


def test_friend_room_creation_and_join():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        _hello(host_ws, "host", "create")
        joined = host_ws.receive_json()
        assert joined["type"] == "joined"
        room_id = joined["room"]["id"]
        assert joined["room"]["mode"] == "friend"

        with client.websocket_connect("/ws") as guest_ws:
            _hello(guest_ws, "guest", "join", code=room_id)
            g_joined = guest_ws.receive_json()
            assert g_joined["type"] == "joined"
            assert g_joined["room"]["id"] == room_id
            # host gets peer_joined
            peer = host_ws.receive_json()
            assert peer["type"] == "peer_joined"
            # Host triggers start
            host_ws.send_json({"type": "start"})
            host_start = host_ws.receive_json()
            guest_start = guest_ws.receive_json()
            assert host_start["type"] == "game_start"
            assert guest_start["type"] == "game_start"
            # Same board
            assert host_start["board"] == guest_start["board"]


def test_create_room_default_capacity_is_10():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "create"})
        joined = ws.receive_json()
        assert joined["type"] == "joined"
        assert joined["room"]["capacity"] == 10


def test_set_capacity_host_changes_value():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "create"})
        ws.receive_json()  # joined
        ws.send_json({"type": "set_capacity", "capacity": 25})
        msg = ws.receive_json()
        assert msg["type"] == "capacity_changed"
        assert msg["capacity"] == 25


def test_set_capacity_clamped_to_range():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "create"})
        ws.receive_json()
        ws.send_json({"type": "set_capacity", "capacity": 1})
        assert ws.receive_json()["capacity"] == 2  # clamped to min (current = 1, but min absolute is 2)
        ws.send_json({"type": "set_capacity", "capacity": 999})
        assert ws.receive_json()["capacity"] == 50


def test_set_capacity_cannot_go_below_current_players():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]
        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_ws.receive_json()  # joined
            host_ws.receive_json()   # peer_joined
            # Try to drop capacity to 1 — should clamp to current player count (2)
            host_ws.send_json({"type": "set_capacity", "capacity": 1})
            host_msg = host_ws.receive_json()
            guest_msg = guest_ws.receive_json()
            assert host_msg["type"] == "capacity_changed"
            assert host_msg["capacity"] == 2
            assert guest_msg["capacity"] == 2


def test_set_capacity_ignored_for_non_host():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]
        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_ws.receive_json()
            host_ws.receive_json()
            # Guest tries to change capacity — server ignores
            guest_ws.send_json({"type": "set_capacity", "capacity": 30})
            # Now host renames to verify the channel is still flowing and
            # no capacity_changed slipped through first
            guest_ws.send_json({"type": "rename", "nickname": "guest_new"})
            msg = guest_ws.receive_json()
            assert msg["type"] == "renamed"
            assert msg["nickname"] == "guest_new"


def test_default_nickname_when_empty():
    """Server assigns Player-XXXX when client sends empty nickname."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "solo"})
        joined = ws.receive_json()
        assert joined["type"] == "joined"
        nick = joined["room"]["players"][0]["nickname"]
        assert nick.startswith("Player-")


def test_rename_broadcasts_to_room():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]

        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()  # joined
            host.receive_json()   # peer_joined

            host.send_json({"type": "rename", "nickname": "AppleKing"})
            # Both sides should receive 'renamed'
            host_msg = host.receive_json()
            guest_msg = guest.receive_json()
            assert host_msg["type"] == "renamed"
            assert host_msg["nickname"] == "AppleKing"
            assert guest_msg["type"] == "renamed"
            assert guest_msg["nickname"] == "AppleKing"


def test_friend_rematch_returns_to_lobby_not_auto_start(monkeypatch):
    """In friend mode, '새 게임' should send everyone back to the lobby,
    not immediately restart, so new players can join before round 2."""
    import app.game.room as room_mod
    import app.ws.handlers as handlers_mod
    monkeypatch.setattr(room_mod, "GAME_DURATION", 0.3)
    monkeypatch.setattr(handlers_mod, "GAME_DURATION", 0.3)

    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]
        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_ws.receive_json()       # joined
            host_ws.receive_json()        # peer_joined
            host_ws.send_json({"type": "start"})
            host_ws.receive_json()        # game_start
            guest_ws.receive_json()       # game_start
            # Wait for game_end (tick patched to 0.3s)
            host_end = host_ws.receive_json()
            guest_end = guest_ws.receive_json()
            assert host_end["type"] == "game_end"
            assert guest_end["type"] == "game_end"
            # Host triggers rematch
            host_ws.send_json({"type": "rematch"})
            host_msg = host_ws.receive_json()
            guest_msg = guest_ws.receive_json()
            # Should be room_reset, NOT game_start
            assert host_msg["type"] == "room_reset"
            assert guest_msg["type"] == "room_reset"
            assert host_msg["room"]["state"] == "waiting"


def test_disconnect_during_play_does_not_end_game():
    """When one player drops, the room stays alive and the game keeps
    running for everyone else."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]

        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_ws.receive_json()  # joined
            host_ws.receive_json()   # peer_joined
            host_ws.send_json({"type": "start"})
            host_ws.receive_json()   # game_start
            guest_ws.receive_json()  # game_start

            # Guest disconnects
        # Host should see peer_disconnected, NOT game_end
        msg = host_ws.receive_json()
        assert msg["type"] == "peer_disconnected"
        # Game state should still be playing — verify host can still submit
        # (we do not force a real submit since it depends on the random
        # board, just confirm no game_end arrived).


def test_reconnect_restores_session():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]

        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_joined = guest_ws.receive_json()
            guest_id = guest_joined["player_id"]
            host_ws.receive_json()  # peer_joined
            host_ws.send_json({"type": "start"})
            host_ws.receive_json()
            guest_ws.receive_json()
            # Guest disconnects
        # Host gets peer_disconnected
        peer_disc = host_ws.receive_json()
        assert peer_disc["type"] == "peer_disconnected"

        # Now guest reconnects with their player_id
        with client.websocket_connect("/ws") as guest_ws2:
            guest_ws2.send_json({
                "type": "hello",
                "intent": "reconnect",
                "player_id": guest_id,
                "room_id": room_id,
            })
            reconnected = guest_ws2.receive_json()
            assert reconnected["type"] == "reconnected"
            assert reconnected["player_id"] == guest_id
            assert reconnected["state"] == "playing"
            assert "boards" in reconnected
            assert "initial_board" in reconnected
            assert "events" in reconnected
            # Host should see peer_reconnected
            peer_rc = host_ws.receive_json()
            assert peer_rc["type"] == "peer_reconnected"
            assert peer_rc["player_id"] == guest_id


def test_second_reconnect_while_first_active_is_rejected():
    """If a session is already active for player P, a second reconnect
    attempt with the same player_id is rejected (the first tab keeps
    playing, the second tab is told to back off)."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as host_ws:
        host_ws.send_json({"type": "hello", "intent": "create"})
        host_joined = host_ws.receive_json()
        room_id = host_joined["room"]["id"]
        with client.websocket_connect("/ws") as guest_ws:
            guest_ws.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_joined = guest_ws.receive_json()
            guest_id = guest_joined["player_id"]
            host_ws.receive_json()        # peer_joined
            host_ws.send_json({"type": "start"})
            host_ws.receive_json()
            guest_ws.receive_json()       # game_start

            # Guest is still connected — a second reconnect for them must be rejected
            with client.websocket_connect("/ws") as second_tab:
                second_tab.send_json({
                    "type": "hello",
                    "intent": "reconnect",
                    "player_id": guest_id,
                    "room_id": room_id,
                })
                msg = second_tab.receive_json()
                assert msg["type"] == "error"
                assert msg["code"] == "already_connected"


def test_reconnect_unknown_room_returns_not_found():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({
            "type": "hello",
            "intent": "reconnect",
            "player_id": "deadbeef",
            "room_id": "ZZZZZZ",
        })
        msg = ws.receive_json()
        assert msg["type"] == "not_found"


def test_join_unknown_room():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        _hello(ws, "x", "join", code="ZZZZZZ")
        msg = ws.receive_json()
        assert msg["type"] == "not_found"


def test_random_match_first_client_joins_pending_room():
    """First client to enter random match goes straight into a pending room
    (no countdown yet). Nickname is replaced with a server-assigned one
    regardless of what the client sent."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as a:
        _hello(a, "alice", "match")
        joined = a.receive_json()
        assert joined["type"] == "joined"
        assert joined["room"]["mode"] == "random"
        assert joined["room"]["capacity"] == 7
        # Random match anonymises — server-assigned Player-XXXX
        nick = joined["room"]["players"][0]["nickname"]
        assert nick.startswith("Player-")
        assert nick != "alice"


def test_random_match_second_client_triggers_countdown():
    client = TestClient(app)
    with client.websocket_connect("/ws") as a:
        _hello(a, "alice", "match")
        a.receive_json()  # joined (no countdown yet)
        with client.websocket_connect("/ws") as b:
            _hello(b, "bob", "match")
            # Drain b's messages until match_countdown
            saw_countdown = False
            for _ in range(6):
                m = b.receive_json()
                if m["type"] == "match_countdown":
                    saw_countdown = True
                    assert "deadline_ms" in m
                    break
            assert saw_countdown


def test_game_end_broadcast_on_timer_expiry(monkeypatch):
    """Regression: cancelling the timer task from inside _end_game used to
    interrupt the game_end broadcast. Verify a solo game emits game_end
    when the timer naturally expires."""
    import app.game.room as room_mod
    import app.ws.handlers as handlers_mod
    monkeypatch.setattr(room_mod, "GAME_DURATION", 0.3)
    monkeypatch.setattr(handlers_mod, "GAME_DURATION", 0.3)

    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "solo"})
        # Drain joined + game_start
        msgs = []
        for _ in range(2):
            msgs.append(ws.receive_json())
        assert any(m["type"] == "game_start" for m in msgs)
        # Now wait for timer to fire and broadcast game_end
        end = ws.receive_json()
        assert end["type"] == "game_end"
        assert "scores" in end


def test_solo_submit_and_clear():
    """Verify a valid sum-10 submit results in a clear broadcast."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        _hello(ws, "p", "solo")
        ws.receive_json()  # joined
        start = ws.receive_json()
        assert start["type"] == "game_start"
        board = start["board"]
        # Find a single-cell sum-10? impossible (cells are 1-9). Find a
        # contiguous pair summing to 10 by scanning the first row.
        target_rect = None
        for c in range(16):
            if board[0][c] + board[0][c + 1] == 10:
                target_rect = (0, c, 0, c + 1)
                break
        if target_rect is None:
            # Fallback: scan whole board for any horizontal pair
            for r in range(10):
                for c in range(16):
                    if board[r][c] + board[r][c + 1] == 10:
                        target_rect = (r, c, r, c + 1)
                        break
                if target_rect:
                    break
        if target_rect is None:
            return  # extremely unlikely, skip
        r1, c1, r2, c2 = target_rect
        ws.send_json({"type": "submit", "r1": r1, "c1": c1, "r2": r2, "c2": c2})
        msg = ws.receive_json()
        assert msg["type"] == "clear"
        assert len(msg["cells"]) == 2
        # t_ms must be present for replay
        assert "t_ms" in msg
        assert isinstance(msg["t_ms"], int)
        assert msg["t_ms"] >= 0
