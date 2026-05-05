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


def test_join_unknown_room():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        _hello(ws, "x", "join", code="ZZZZZZ")
        msg = ws.receive_json()
        assert msg["type"] == "not_found"


def test_random_match_first_client_queued():
    """First client to enter random match gets queued message."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as a:
        _hello(a, "alice", "match")
        first = a.receive_json()
        assert first["type"] == "queued"
        assert first["position"] >= 1


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
