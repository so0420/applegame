from app.game.board import COLS, ROWS, generate_board, validate_and_clear


def test_board_shape():
    b = generate_board(seed=1)
    assert len(b) == ROWS
    assert all(len(row) == COLS for row in b)
    assert all(1 <= v <= 9 for row in b for v in row)


def test_validate_and_clear_success():
    b = [[1] * COLS for _ in range(ROWS)]
    cells = validate_and_clear(b, 0, 0, 0, 9)  # ten 1s = 10
    assert cells is not None
    assert len(cells) == 10
    assert all(b[0][c] == 0 for c in range(10))
    assert b[0][10] == 1  # untouched


def test_validate_and_clear_fail_sum_not_ten():
    b = [[1] * COLS for _ in range(ROWS)]
    assert validate_and_clear(b, 0, 0, 0, 8) is None  # sum = 9
    assert validate_and_clear(b, 0, 0, 0, 10) is None  # sum = 11
    # Board untouched
    assert all(v == 1 for row in b for v in row)


def test_ignores_already_cleared_cells():
    b = [[1] * COLS for _ in range(ROWS)]
    b[0][3] = 0  # already cleared
    # nine remaining 1s in cols 0..9 sum to 9 → fail
    assert validate_and_clear(b, 0, 0, 0, 9) is None
    # cols 0..10 minus col3 = 10 ones → ok
    cells = validate_and_clear(b, 0, 0, 0, 10)
    assert cells is not None
    assert len(cells) == 10


def test_out_of_bounds():
    b = generate_board(seed=2)
    assert validate_and_clear(b, -1, 0, 0, 0) is None
    assert validate_and_clear(b, 0, 0, ROWS, 0) is None
    assert validate_and_clear(b, 0, 0, 0, COLS) is None
    assert validate_and_clear(b, 5, 5, 4, 5) is None  # r1 > r2


def test_empty_region():
    b = [[0] * COLS for _ in range(ROWS)]
    assert validate_and_clear(b, 0, 0, 0, 0) is None
