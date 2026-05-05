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


def test_capacity():
    assert Room(id="X", mode="solo").capacity == 1
    assert Room(id="X", mode="friend").capacity == 2
    assert Room(id="X", mode="random").capacity == 2
