from app.game.room import Player, Room


def test_winner_higher_score():
    r = Room(id="X", mode="random")
    a = Player(id="a", nickname="A", score=10, last_score_ts=100.0)
    b = Player(id="b", nickname="B", score=8, last_score_ts=50.0)
    r.players = {"a": a, "b": b}
    assert r.determine_winner() == "a"


def test_winner_tiebreak_by_earlier_last_score():
    r = Room(id="X", mode="random")
    a = Player(id="a", nickname="A", score=5, last_score_ts=100.0)
    b = Player(id="b", nickname="B", score=5, last_score_ts=80.0)
    r.players = {"a": a, "b": b}
    # Same score: earlier (smaller) last_score_ts wins
    assert r.determine_winner() == "b"


def test_winner_none_on_total_tie():
    r = Room(id="X", mode="random")
    a = Player(id="a", nickname="A", score=0, last_score_ts=0.0)
    b = Player(id="b", nickname="B", score=0, last_score_ts=0.0)
    r.players = {"a": a, "b": b}
    assert r.determine_winner() is None


def test_capacity_is_stored_field():
    assert Room(id="X", mode="solo", capacity=1).capacity == 1
    assert Room(id="X", mode="friend", capacity=10).capacity == 10
    assert Room(id="X", mode="friend", capacity=50).capacity == 50


def test_start_creates_independent_boards_per_player():
    r = Room(id="X", mode="random")
    a = Player(id="a", nickname="A")
    b = Player(id="b", nickname="B")
    r.players = {"a": a, "b": b}
    r.start()
    assert set(r.boards.keys()) == {"a", "b"}
    # Same starting layout
    assert r.boards["a"] == r.boards["b"]
    # But independent objects: mutating one doesn't affect the other
    r.boards["a"][0][0] = 0
    assert r.boards["b"][0][0] != 0
    # Per-player apples_left
    assert r.apples_left == {"a": 170, "b": 170}


def test_initial_board_returns_starting_state():
    r = Room(id="X", mode="solo")
    a = Player(id="a", nickname="A")
    r.players = {"a": a}
    r.start()
    assert r.initial_board == r.boards["a"]
    assert len(r.initial_board) == 10 and len(r.initial_board[0]) == 17
