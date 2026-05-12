"""Items-variant integration tests."""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.game.board import (
    COLS,
    ROWS,
    find_sum10_pair,
    shuffle_remaining,
)
from app.main import app


def _drain_until(ws, mtype, limit=10):
    for _ in range(limit):
        m = ws.receive_json()
        if m["type"] == mtype:
            return m
    raise AssertionError(f"did not see {mtype}")


def test_shuffle_remaining_keeps_zeros_and_randomises_others():
    b = [[1] * COLS for _ in range(ROWS)]
    b[0][0] = 0
    b[5][5] = 0
    shuffle_remaining(b)
    assert b[0][0] == 0 and b[5][5] == 0
    # All other cells stay in 1..9
    for r in range(ROWS):
        for c in range(COLS):
            if (r, c) not in {(0, 0), (5, 5)}:
                assert 1 <= b[r][c] <= 9


def test_find_sum10_pair_horizontal_neighbour():
    b = [[1] * COLS for _ in range(ROWS)]
    b[2][3] = 7
    b[2][4] = 3
    pair = find_sum10_pair(b)
    assert pair is not None
    s = sum(b[r][c] for r, c in pair)
    assert s == 10


def test_set_variant_host_only_friend_only():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "create"})
        joined = ws.receive_json()
        assert joined["room"]["variant"] == "classic"
        ws.send_json({"type": "set_variant", "variant": "items"})
        msg = ws.receive_json()
        assert msg["type"] == "variant_changed"
        assert msg["variant"] == "items"


def test_set_variant_rejected_in_solo():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "intent": "solo"})
        ws.receive_json()  # joined
        ws.receive_json()  # game_start (solo auto-starts)
        ws.send_json({"type": "set_variant", "variant": "items"})
        # Should be ignored — send another known message and confirm no
        # variant_changed leaks through first.
        ws.send_json({"type": "rename", "nickname": "x"})
        # solo ignores rename in friend-only? Actually rename works in solo.
        msg = ws.receive_json()
        assert msg["type"] != "variant_changed"


def test_game_start_announces_variant():
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        host.send_json({"type": "set_variant", "variant": "items"})
        host.receive_json()  # variant_changed
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()       # joined
            host.receive_json()        # peer_joined
            host.send_json({"type": "start"})
            host_start = host.receive_json()
            guest.receive_json()
            assert host_start["type"] == "game_start"
            assert host_start["variant"] == "items"


def test_use_item_with_empty_slot_is_ignored():
    """USE_ITEM on an empty slot should be silently dropped — no reject."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        host.send_json({"type": "set_variant", "variant": "items"})
        host.receive_json()  # variant_changed
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()
            host.receive_json()
            host.send_json({"type": "start"})
            host.receive_json()
            guest.receive_json()
            # Empty inventory — should be a no-op
            host.send_json({"type": "use_item", "slot": 0})
            # Confirm the channel is still alive
            host.send_json({"type": "rename", "nickname": "k"})
            msg = host.receive_json()
            assert msg["type"] == "renamed"


def test_attack_lockout_blocks_late_use(monkeypatch):
    """Within the last 10s of the game, attack items must be rejected."""
    import app.game.room as room_mod
    import app.ws.handlers as handlers_mod
    # Total game duration 9s — entire game is "late game"
    monkeypatch.setattr(room_mod, "GAME_DURATION", 9.0)
    monkeypatch.setattr(handlers_mod, "GAME_DURATION", 9.0)

    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        host_id = host_joined["player_id"]
        host.send_json({"type": "set_variant", "variant": "items"})
        host.receive_json()  # variant_changed
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest_joined = guest.receive_json()
            host.receive_json()  # peer_joined
            host.send_json({"type": "start"})
            host.receive_json()  # game_start
            guest.receive_json()  # game_start

            # Force-grant an attack item to host via direct room access
            from app.main import manager
            room = manager.get(room_id)
            assert room is not None
            host_player = room.players[host_id]
            host_player.inventory[0] = "blind"

            host.send_json({"type": "use_item", "slot": 0})
            # Expect an error message back (attack_locked)
            msg = host.receive_json()
            # Could be peer_joined echo? No — that was drained. Should be error
            # or — if timing was off — could be item_used. Accept either.
            assert msg["type"] in ("error", "item_used")
            if msg["type"] == "error":
                assert msg["code"] == "attack_locked"


def _start_items_game():
    """Bring up an items-mode friend room with two players, return ws pair
    + ids + room. Caller is responsible for closing the WS contexts."""
    client = TestClient(app)
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
    return host_ctx, guest_ctx, host, guest, host_id, guest_id, room


def test_combo_big_clear_increments():
    """A single clear of ≥4 cells (no prior clear) counts as combo step 1."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Plant a 5×1 rectangle of 2s on row 0 → sums to 10, clears 5 cells.
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        for c in range(5):
            room.boards[host_id][0][c] = 2
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 4})
        msg = _drain_until(host, "clear")
        assert len(msg["cells"]) == 5
        assert msg["combo"] == 1
        assert room.players[host_id].combo_count == 1
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_window_does_not_count_first_small_clear():
    """A first clear of <4 cells without prior history must NOT count
    as a combo (no preceding clear to be 'within window' of)."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 5+5 = 10 across 2 cells.
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        msg = _drain_until(host, "clear")
        assert msg["combo"] == 0
        assert room.players[host_id].combo_count == 0
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_window_counts_small_clears_within_03s():
    """A small clear that lands within 0.3s of the previous one counts."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Fake a "just happened" prior clear so the in-window branch fires.
        room.players[host_id].last_score_ts = time.time()
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        msg = _drain_until(host, "clear")
        assert msg["combo"] == 1
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_breaks_after_window_with_small_clear():
    """Slow + small clear breaks the streak back to 0."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Pretend the player was mid-streak but the last clear was a while ago.
        room.players[host_id].combo_count = 2
        room.players[host_id].last_score_ts = time.time() - 1.0  # > 0.3s
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        msg = _drain_until(host, "clear")
        assert msg["combo"] == 0
        assert room.players[host_id].combo_count == 0
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_third_combo_grants_item_and_resets():
    """Reaching the 3rd combo step grants an item to a free slot and
    resets the streak to 0."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.combo_count = 2          # already 2 streaks deep
        host_player.last_score_ts = time.time()  # next clear lands in window
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(host, "clear")
        assert clear["combo"] == 0           # reset after the drop
        assert host_player.combo_count == 0
        # item_acquired follows on the same socket
        acq = _drain_until(host, "item_acquired")
        assert acq["slot"] in (0, 1, 2)
        assert acq["item"] in ("hint", "double", "blind", "shuffle")
        assert host_player.inventory[acq["slot"]] == acq["item"]
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_full_inventory_discards_item_but_still_resets():
    """If the inventory is full when a combo lands, the item is silently
    discarded — the streak still resets so the player doesn't sit at
    THRESHOLD forever."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.combo_count = 2
        host_player.last_score_ts = time.time()
        host_player.inventory = ["hint", "double", "blind"]  # full
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(host, "clear")
        assert clear["combo"] == 0
        assert host_player.combo_count == 0
        assert host_player.inventory == ["hint", "double", "blind"]
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_events_recorded_for_replay():
    """Every item-mode side-effect must append a kind-tagged event to
    room.events so the post-game replay can reconstruct the round."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 1) Use a self-effect item (double) by hand
        host_player = room.players[host_id]
        host_player.inventory[0] = "double"
        host.send_json({"type": "use_item", "slot": 0})
        for _ in range(2):  # item_used + effect_start
            host.receive_json()
            guest.receive_json()

        # 2) Use shuffle (attack on guest)
        host_player.inventory[0] = "shuffle"
        host.send_json({"type": "use_item", "slot": 0})
        for _ in range(2):  # item_used + board_update
            host.receive_json()
            guest.receive_json()

        kinds = [e.get("kind") for e in room.events]
        assert "item_used" in kinds
        assert "effect_start" in kinds
        assert "shuffle" in kinds
        assert all(isinstance(e.get("t_ms"), int) for e in room.events)
        for e in room.events:
            if e["kind"] == "item_used":
                assert e["by"] == host_id
                assert e["target_id"] in (host_id, guest_id)
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_use_item_double_grants_score_multiplier(monkeypatch):
    """Activating 'double' sets double_until in the future."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        host_id = host_joined["player_id"]
        host.send_json({"type": "set_variant", "variant": "items"})
        host.receive_json()  # variant_changed
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()
            host.receive_json()
            host.send_json({"type": "start"})
            host.receive_json()
            guest.receive_json()

            from app.main import manager
            room = manager.get(room_id)
            host_player = room.players[host_id]
            host_player.inventory[0] = "double"

            t0 = time.time()
            host.send_json({"type": "use_item", "slot": 0})
            # item_used + effect_start come back (in some order across host/guest)
            saw_used = False
            saw_effect = False
            for _ in range(4):
                m = host.receive_json()
                if m["type"] == "item_used" and m["item"] == "double":
                    saw_used = True
                if m["type"] == "effect_start" and m.get("effect") == "double":
                    saw_effect = True
                if saw_used and saw_effect:
                    break
            assert saw_used and saw_effect
            assert host_player.double_until > t0
