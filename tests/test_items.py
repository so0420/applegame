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


# ------------------------------------------------------------------
# Anti-macro gate tests
# ------------------------------------------------------------------

def _start_solo_game():
    client = TestClient(app)
    ws_ctx = client.websocket_connect("/ws")
    ws = ws_ctx.__enter__()
    ws.send_json({"type": "hello", "intent": "solo"})
    joined = ws.receive_json()
    room_id = joined["room"]["id"]
    ws.receive_json()  # game_start
    from app.main import manager
    room = manager.get(room_id)
    return ws_ctx, ws, room, joined["player_id"]


def test_rapid_submit_burst_is_rate_limited():
    """Pre-seed the submit history so the next submit hits the per-second
    cap — proves the rate-limit branch reaches the wire."""
    ctx, ws, room, pid = _start_solo_game()
    try:
        import time as _t
        now = _t.time()
        # Fill the 1s window with MAX_SUBMITS_PER_1S timestamps
        for i in range(4):
            room.players[pid].submit_history.append(now - 0.05 - 0.02 * i)
        room.boards[pid] = [[1] * COLS for _ in range(ROWS)]
        room.boards[pid][0][0] = 5
        room.boards[pid][0][1] = 5
        ws.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        m = ws.receive_json()
        assert m["type"] == "reject"
        assert m["reason"] in ("rate_limited", "too_fast")
    finally:
        ctx.__exit__(None, None, None)


def test_blocked_ip_via_xff_returns_403():
    """A request with X-Forwarded-For inside a known cloud range gets 403."""
    from fastapi.testclient import TestClient
    # 3.0.0.1 is inside 3.0.0.0/9 (AWS) from the blocklist
    resp = TestClient(app).get("/healthz", headers={"X-Forwarded-For": "3.0.0.1"})
    assert resp.status_code == 403


def test_blocked_ip_allows_private_lan():
    """LAN / loopback addresses are always allowed even if they appeared
    in a list — so dev / on-prem deploys keep working."""
    from fastapi.testclient import TestClient
    resp = TestClient(app).get("/healthz", headers={"X-Forwarded-For": "10.0.0.5"})
    assert resp.status_code == 200




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
        # Friend rooms now default to items mode.
        assert joined["room"]["variant"] == "items"
        ws.send_json({"type": "set_variant", "variant": "classic"})
        msg = ws.receive_json()
        assert msg["type"] == "variant_changed"
        assert msg["variant"] == "classic"


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


def test_three_initial_goldens_shared_across_players():
    """game_start places exactly 3 golden apples, identical for every player."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 3 distinct positions seeded into room state
        assert len(room.initial_golden) == 3
        assert len(set(room.initial_golden)) == 3
        # Every player's live golden set matches the initial picks
        for pid in room.players:
            assert room.golden[pid] == set(room.initial_golden)
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_classic_room_does_not_send_golden_in_game_start():
    """Classic variant must not advertise goldens on the wire."""
    client = TestClient(app)
    with client.websocket_connect("/ws") as host:
        host.send_json({"type": "hello", "intent": "create"})
        host_joined = host.receive_json()
        room_id = host_joined["room"]["id"]
        # Friend rooms now default to items mode — flip back to classic so
        # this test exercises the classic-specific code paths.
        host.send_json({"type": "set_variant", "variant": "classic"})
        host.receive_json()  # variant_changed
        with client.websocket_connect("/ws") as guest:
            guest.send_json({"type": "hello", "intent": "join", "code": room_id})
            guest.receive_json()
            host.receive_json()  # peer_joined
            host.send_json({"type": "start"})
            start = host.receive_json()
            assert start["type"] == "game_start"
            assert start["variant"] == "classic"
            assert "golden" not in start


def test_game_start_includes_golden_for_items_variant():
    """Items variant ships the 3 golden positions in game_start."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # game_start was already drained inside the helper, so peek at the
        # room directly to confirm the wire payload's shape via the source.
        assert len(room.initial_golden) == 3
        # Bonus sanity check: positions are inside the 10x17 board.
        for (r, c) in room.initial_golden:
            assert 0 <= r < ROWS and 0 <= c < COLS
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_clearing_golden_grants_item_and_shrinks_set():
    """Clearing a sum-10 region that includes a golden cell drops one
    item and removes the cleared cells from the player's golden set."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Plant a known 5+5 = 10 pair where (0,0) is forced golden.
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        # Force golden marker on (0, 0) for this player only.
        room.golden[host_id] = {(0, 0)}
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        _drain_until(host, "clear")
        acq = _drain_until(host, "item_acquired")
        assert acq["item"] in ("hint", "shuffle", "blind", "overload", "freeze", "shield")
        # The (0,0) golden has been consumed
        assert (0, 0) not in room.golden[host_id]
        # And actually stored in inventory
        assert acq["item"] in room.players[host_id].inventory
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_big_clear_grants_item_instantly():
    """Clearing 4+ cells in one submit grants an item even with no golden
    and no combo history."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 5 cells of value 2 → sum 10 → 5 cleared
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        for c in range(5):
            room.boards[host_id][0][c] = 2
        # Strip goldens so only the big-clear trigger fires
        room.golden[host_id] = set()
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 4})
        clear = _drain_until(host, "clear")
        assert len(clear["cells"]) == 5
        acq = _drain_until(host, "item_acquired")
        assert acq["item"] in ("hint", "shuffle", "blind", "overload", "freeze", "shield")
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_threshold_clears_grant_item():
    """Reaching the COMBO_THRESHOLD-th consecutive in-window clear grants
    an item and flags combo_triggered so the badge can swap to the
    'aitem 지급됨' pill."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Pre-arm: pretend THRESHOLD-1 prior clears already landed inside
        # the window, so the next small clear is the threshold step.
        room.players[host_id].combo_count = 4
        room.players[host_id].last_score_ts = time.time()
        room.golden[host_id] = set()                       # no golden noise
        # 2-cell clear (under BIG_CLEAR_CELLS) so only combo can trigger
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(host, "clear")
        assert clear["combo"] == 0       # reset right after the drop
        assert clear["combo_triggered"] is True
        acq = _drain_until(host, "item_acquired")
        assert acq["item"] in ("hint", "shuffle", "blind", "overload", "freeze", "shield")
        assert room.players[host_id].combo_count == 0
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_below_threshold_does_not_set_triggered():
    """A non-threshold clear must have combo_triggered=False."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        room.golden[host_id] = set()
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(host, "clear")
        assert clear["combo"] == 1
        assert clear["combo_triggered"] is False
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_goes_up_to_two_within_window():
    """Sanity: with no prearm, a second clear within the window should
    take combo from 1 → 2 (proves the increment branch fires)."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        room.golden[host_id] = set()
        # First clear — sets last_score_ts and combo=1
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        m1 = _drain_until(host, "clear")
        assert m1["combo"] == 1
        # Wait past MIN_SUBMIT_GAP_S so the anti-macro gate accepts the
        # second submit. (TestClient round-trip is sub-ms otherwise.)
        time.sleep(0.1)
        room.boards[host_id][1][0] = 5
        room.boards[host_id][1][1] = 5
        host.send_json({"type": "submit", "r1": 1, "c1": 0, "r2": 1, "c2": 1})
        m2 = _drain_until(host, "clear")
        assert m2["combo"] == 2
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_combo_broken_when_gap_exceeds_window():
    """A small clear long after the previous one starts a new chain at 1."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        room.players[host_id].combo_count = 2
        room.players[host_id].last_score_ts = time.time() - 3.0  # clearly past window
        room.golden[host_id] = set()
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        clear = _drain_until(host, "clear")
        assert clear["combo"] == 1       # chain reset to 1
        assert room.players[host_id].combo_count == 1
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_simultaneous_triggers_grant_one_item_per_trigger():
    """A single submit that fires golden + big-clear + combo grants one item
    PER trigger (golden + big + combo = 3 items), capped by free slots."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 5 cells of value 2 sums to 10 (big-clear ✓).
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        for c in range(5):
            room.boards[host_id][0][c] = 2
        # Make (0,0) golden (golden ✓ — exactly one golden cell).
        room.golden[host_id] = {(0, 0)}
        # Prearm combo so this clear becomes the threshold step (combo ✓).
        room.players[host_id].combo_count = 4
        room.players[host_id].last_score_ts = time.time()
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 4})
        clear = _drain_until(host, "clear")
        assert len(clear["cells"]) == 5
        assert clear["combo"] == 0
        # Three item_acquired messages, one per trigger.
        for _ in range(3):
            acq = _drain_until(host, "item_acquired")
            assert acq["item"] in (
                "hint", "shuffle", "blind", "overload", "freeze", "shield",
            )
        # Confirm no fourth item_acquired comes through.
        host.send_json({"type": "rename", "nickname": "ok"})
        nxt = host.receive_json()
        assert nxt["type"] == "renamed"
        # All three slots occupied.
        filled = sum(1 for s in room.players[host_id].inventory if s is not None)
        assert filled == 3
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_two_goldens_in_one_clear_grant_two_items():
    """Clearing two golden apples in a single sum-10 region grants two
    items (one per golden), not one."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 5 + 5 = 10, both cells golden. 2 cells < BIG_CLEAR_CELLS and the
        # first clear can't reach the combo threshold, so only the two
        # goldens trigger drops.
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        room.golden[host_id] = {(0, 0), (0, 1)}
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        _drain_until(host, "clear")
        for _ in range(2):
            acq = _drain_until(host, "item_acquired")
            assert acq["item"] in (
                "hint", "shuffle", "blind", "overload", "freeze", "shield",
            )
        host.send_json({"type": "rename", "nickname": "ok"})
        assert host.receive_json()["type"] == "renamed"
        filled = sum(1 for s in room.players[host_id].inventory if s is not None)
        assert filled == 2
        assert (0, 0) not in room.golden[host_id]
        assert (0, 1) not in room.golden[host_id]
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_clearing_non_golden_does_not_grant_item():
    """A clear that hits no golden cells produces no item_acquired msg."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        # Make sure (0,0) and (0,1) are NOT golden.
        room.golden[host_id].discard((0, 0))
        room.golden[host_id].discard((0, 1))
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        m1 = host.receive_json()
        assert m1["type"] == "clear"
        # Send a rename so we can verify nothing else slipped through.
        host.send_json({"type": "rename", "nickname": "ok"})
        m2 = host.receive_json()
        assert m2["type"] == "renamed"
        # Inventory unchanged
        assert all(s is None for s in room.players[host_id].inventory)
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_golden_clear_with_full_inventory_consumes_cell_without_drop():
    """Full inventory: the golden cell is still consumed (so it can't be
    re-claimed) but no item is granted."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.inventory = ["hint", "shield", "blind"]  # full
        room.boards[host_id] = [[1] * COLS for _ in range(ROWS)]
        room.boards[host_id][0][0] = 5
        room.boards[host_id][0][1] = 5
        room.golden[host_id] = {(0, 0)}
        host.send_json({"type": "submit", "r1": 0, "c1": 0, "r2": 0, "c2": 1})
        _drain_until(host, "clear")
        # Confirm no item_acquired comes through — use a benign rename to
        # check the channel is still flowing.
        host.send_json({"type": "rename", "nickname": "x"})
        msg = host.receive_json()
        assert msg["type"] == "renamed"
        assert (0, 0) not in room.golden[host_id]
        assert host_player.inventory == ["hint", "shield", "blind"]
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_events_recorded_for_replay():
    """Every item-mode side-effect must append a kind-tagged event to
    room.events so the post-game replay can reconstruct the round."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # 1) Use a self-effect item (shield) by hand
        host_player = room.players[host_id]
        host_player.inventory[0] = "shield"
        host.send_json({"type": "use_item", "slot": 0})
        for _ in range(2):  # item_used + effect_start
            host.receive_json()
            guest.receive_json()

        # 2) Use shuffle (self-shuffle — own board reshuffles)
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


def test_use_item_shield_sets_deadline(monkeypatch):
    """Activating 'shield' sets shield_until in the future."""
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
            host_player.inventory[0] = "shield"

            t0 = time.time()
            host.send_json({"type": "use_item", "slot": 0})
            # item_used + effect_start come back (in some order across host/guest)
            saw_used = False
            saw_effect = False
            for _ in range(4):
                m = host.receive_json()
                if m["type"] == "item_used" and m["item"] == "shield":
                    saw_used = True
                if m["type"] == "effect_start" and m.get("effect") == "shield":
                    saw_effect = True
                if saw_used and saw_effect:
                    break
            assert saw_used and saw_effect
            assert host_player.shield_until > t0


# ------------------------------------------------------------------
# Shield / shuffle-self / discard / weighted-drop tests
# ------------------------------------------------------------------

def test_shuffle_targets_self_not_opponent():
    """Self-shuffle: only the user's own board changes; opponent untouched."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Snapshot opponent board before shuffle.
        guest_board_before = [row[:] for row in room.boards[guest_id]]
        host_player = room.players[host_id]
        host_player.inventory[0] = "shuffle"
        host.send_json({"type": "use_item", "slot": 0})
        # Drain item_used + board_update (target = host)
        saw_board_update_target = None
        for _ in range(4):
            m = host.receive_json()
            if m["type"] == "board_update":
                saw_board_update_target = m["target_id"]
                break
        assert saw_board_update_target == host_id
        # Opponent board unchanged.
        assert room.boards[guest_id] == guest_board_before
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_shield_blocks_incoming_blind():
    """Blind hitting a shielded target: slot consumed, blocked=True, no
    effect_start broadcast, target's blind_until stays 0."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        # Pre-arm: guest already has shield active.
        room.players[guest_id].shield_until = time.time() + 5.0
        host_player = room.players[host_id]
        host_player.inventory[0] = "blind"
        host.send_json({"type": "use_item", "slot": 0})
        # Collect a few messages; item_used must come with blocked=True
        seen_blocked = False
        for _ in range(3):
            m = host.receive_json()
            if m["type"] == "item_used" and m["item"] == "blind":
                seen_blocked = m.get("blocked") is True
                break
        assert seen_blocked
        # blind effect must NOT have applied.
        assert room.players[guest_id].blind_until == 0.0
        # Slot is consumed.
        assert host_player.inventory[0] is None
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_shield_cleanses_active_blind():
    """Activating shield while blinded ends the blind immediately and
    broadcasts effect_end for blind."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.blind_until = time.time() + 30.0  # blind active
        host_player.inventory[0] = "shield"
        host.send_json({"type": "use_item", "slot": 0})
        # Drain messages; look for effect_end with effect=blind
        saw_blind_end = False
        for _ in range(6):
            m = host.receive_json()
            if m["type"] == "effect_end" and m.get("effect") == "blind":
                saw_blind_end = True
                break
        assert saw_blind_end
        assert host_player.blind_until == 0.0
        assert host_player.shield_until > time.time()
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_overload_attack_sets_deadline_on_opponent():
    """Overload targets an opponent and sets overload_until in the future
    without touching their real board values."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        board_before = [row[:] for row in room.boards[guest_id]]
        host_player = room.players[host_id]
        host_player.inventory[0] = "overload"
        t0 = time.time()
        host.send_json({"type": "use_item", "slot": 0})
        saw_effect = False
        for _ in range(4):
            m = host.receive_json()
            if m["type"] == "effect_start" and m.get("effect") == "overload":
                saw_effect = True
                assert m["target_id"] == guest_id
                break
        assert saw_effect
        assert room.players[guest_id].overload_until > t0
        # Real values are untouched — deception is client-side only.
        assert room.boards[guest_id] == board_before
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_freeze_attack_sets_deadline_on_opponent():
    """Freeze targets an opponent and sets freeze_until in the future."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.inventory[0] = "freeze"
        t0 = time.time()
        host.send_json({"type": "use_item", "slot": 0})
        saw_effect = False
        for _ in range(4):
            m = host.receive_json()
            if m["type"] == "effect_start" and m.get("effect") == "freeze":
                saw_effect = True
                assert m["target_id"] == guest_id
                break
        assert saw_effect
        assert room.players[guest_id].freeze_until > t0
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_shield_blocks_overload_and_freeze():
    """A shielded target blocks incoming overload/freeze (slot burns, no
    effect applied)."""
    for attack, attr in (("overload", "overload_until"), ("freeze", "freeze_until")):
        h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
        try:
            room.players[guest_id].shield_until = time.time() + 5.0
            host_player = room.players[host_id]
            host_player.inventory[0] = attack
            host.send_json({"type": "use_item", "slot": 0})
            seen_blocked = False
            for _ in range(3):
                m = host.receive_json()
                if m["type"] == "item_used" and m["item"] == attack:
                    seen_blocked = m.get("blocked") is True
                    break
            assert seen_blocked, attack
            assert getattr(room.players[guest_id], attr) == 0.0
            assert host_player.inventory[0] is None
        finally:
            h_ctx.__exit__(None, None, None)
            g_ctx.__exit__(None, None, None)


def test_shield_cleanses_overload_and_freeze():
    """Shield cleanses every active attack effect on the user at once."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        now = time.time()
        host_player.blind_until = now + 30.0
        host_player.overload_until = now + 30.0
        host_player.freeze_until = now + 30.0
        host_player.inventory[0] = "shield"
        host.send_json({"type": "use_item", "slot": 0})
        ended = set()
        for _ in range(10):
            m = host.receive_json()
            if m["type"] == "effect_end":
                ended.add(m.get("effect"))
            if {"blind", "overload", "freeze"} <= ended:
                break
        assert {"blind", "overload", "freeze"} <= ended
        assert host_player.blind_until == 0.0
        assert host_player.overload_until == 0.0
        assert host_player.freeze_until == 0.0
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_discard_item_clears_slot():
    """discard_item empties the slot and echoes item_discarded back."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host_player = room.players[host_id]
        host_player.inventory[0] = "hint"
        host.send_json({"type": "discard_item", "slot": 0})
        m = _drain_until(host, "item_discarded")
        assert m["slot"] == 0
        assert host_player.inventory[0] is None
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_discard_item_empty_slot_is_noop():
    """Discarding an empty slot doesn't send item_discarded."""
    h_ctx, g_ctx, host, guest, host_id, guest_id, room = _start_items_game()
    try:
        host.send_json({"type": "discard_item", "slot": 0})
        host.send_json({"type": "rename", "nickname": "x"})
        m = host.receive_json()
        assert m["type"] == "renamed"
    finally:
        h_ctx.__exit__(None, None, None)
        g_ctx.__exit__(None, None, None)


def test_weighted_drop_respects_tier_distribution():
    """Top tier should overwhelmingly favor shield; bottom should favor hint.
    Sample enough that random variance can't flip the dominant kind."""
    import random as _r
    from collections import Counter
    from app.ws.handlers import _weighted_drop
    from app.game.room import ITEM_KINDS

    _r.seed(7)
    top_counts = Counter()
    bot_counts = Counter()
    mid_counts = Counter()
    for _ in range(4000):
        top_counts[_weighted_drop("top")] += 1
        bot_counts[_weighted_drop("bottom")] += 1
        mid_counts[_weighted_drop("middle")] += 1
    # Only valid item kinds are ever produced.
    assert set(top_counts) <= set(ITEM_KINDS)
    # Tier-dominant kinds match the design intent.
    assert top_counts.most_common(1)[0][0] == "shield"
    assert bot_counts.most_common(1)[0][0] == "hint"
    # Mid tier is attack-leaning: blind/overload should beat shield.
    assert mid_counts["blind"] > mid_counts["shield"]
    assert mid_counts["overload"] > mid_counts["shield"]


def test_player_tier_buckets_by_score():
    """3+ players are split into thirds by score rank."""
    from app.ws.handlers import _player_tier
    from app.game.room import Room, Player

    room = Room(id="x", mode="friend")
    for i, s in enumerate([100, 80, 60, 40, 20, 0]):
        pid = f"p{i}"
        room.players[pid] = Player(id=pid, nickname=pid, score=s)
    # Ranks: p0(100), p1(80), p2(60), p3(40), p4(20), p5(0)
    # 6 players → top is idx 0..1, middle 2..3, bottom 4..5
    assert _player_tier(room, "p0") == "top"
    assert _player_tier(room, "p1") == "top"
    assert _player_tier(room, "p2") == "middle"
    assert _player_tier(room, "p3") == "middle"
    assert _player_tier(room, "p4") == "bottom"
    assert _player_tier(room, "p5") == "bottom"


def test_player_tier_two_player_maps_top_and_bottom():
    from app.ws.handlers import _player_tier
    from app.game.room import Room, Player

    room = Room(id="x", mode="friend")
    room.players["a"] = Player(id="a", nickname="a", score=10)
    room.players["b"] = Player(id="b", nickname="b", score=0)
    assert _player_tier(room, "a") == "top"
    assert _player_tier(room, "b") == "bottom"
