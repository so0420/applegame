"""Board generation and rectangle-sum validation."""
from __future__ import annotations

import random

ROWS = 10
COLS = 17
TOTAL = ROWS * COLS  # 170
TARGET_SUM = 10


def generate_board(seed: int | None = None) -> list[list[int]]:
    rng = random.Random(seed)
    return [[rng.randint(1, 9) for _ in range(COLS)] for _ in range(ROWS)]


def validate_and_clear(
    board: list[list[int]], r1: int, c1: int, r2: int, c2: int
) -> list[tuple[int, int]] | None:
    """Validate the rectangular region sums to 10 and clear it.

    Returns the list of cleared cell coordinates, or None if invalid.
    """
    if not (0 <= r1 <= r2 < ROWS and 0 <= c1 <= c2 < COLS):
        return None

    total = 0
    cells: list[tuple[int, int]] = []
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            v = board[r][c]
            if v == 0:
                continue
            total += v
            cells.append((r, c))

    if total != TARGET_SUM or not cells:
        return None

    for r, c in cells:
        board[r][c] = 0
    return cells


def shuffle_remaining(
    board: list[list[int]], rng: random.Random | None = None
) -> None:
    """Randomise values of every non-zero cell in-place. Cleared cells stay 0."""
    rng = rng or random.Random()
    for r in range(ROWS):
        for c in range(COLS):
            if board[r][c] != 0:
                board[r][c] = rng.randint(1, 9)


def find_sum10_pair(board: list[list[int]]) -> list[tuple[int, int]] | None:
    """Return a 2-cell list whose values sum to 10 (any orthogonal direction
    over contiguous non-zero cells). Used by the 'hint' item.

    We scan adjacent (r,c)+(r,c+1) and (r,c)+(r+1,c) pairs first, then fall
    back to any rectangle of size up to 1×N or N×1 that sums to 10 — keeping
    the highlight readable.
    """
    # 1) Horizontal / vertical neighbours
    for r in range(ROWS):
        for c in range(COLS - 1):
            a, b = board[r][c], board[r][c + 1]
            if a and b and a + b == 10:
                return [(r, c), (r, c + 1)]
    for r in range(ROWS - 1):
        for c in range(COLS):
            a, b = board[r][c], board[r + 1][c]
            if a and b and a + b == 10:
                return [(r, c), (r + 1, c)]
    # 2) Any horizontal run summing to 10 (up to 5 cells — values are 1..9)
    for r in range(ROWS):
        for c1 in range(COLS):
            total = 0
            run: list[tuple[int, int]] = []
            for c2 in range(c1, min(COLS, c1 + 10)):
                v = board[r][c2]
                if v == 0:
                    break
                total += v
                run.append((r, c2))
                if total == 10 and len(run) >= 2:
                    return run
                if total > 10:
                    break
    return None


def find_sum10_rect(
    board: list[list[int]], rng: random.Random | None = None
) -> tuple[int, int, int, int] | None:
    """Pick a random axis-aligned rectangle (r1,c1,r2,c2) whose non-zero
    cells sum to 10, or None if the board has no move left. Used by the AI
    partner. Smaller rectangles are strongly preferred so the bot's moves
    look human (mostly pairs / short runs).

    Row-pair column sums + a sliding window: for each (r1,r2) and each right
    edge, the shrinking left pointer yields the window summing to 10.
    """
    rng = rng or random.Random()
    candidates: list[tuple[int, int, int, int, int]] = []  # (r1,c1,r2,c2,ncells)
    for r1 in range(ROWS):
        col_sum = [0] * COLS
        for r2 in range(r1, ROWS):
            for c in range(COLS):
                col_sum[c] += board[r2][c]
            lo = 0
            window = 0
            for hi in range(COLS):
                window += col_sum[hi]
                while window > TARGET_SUM and lo <= hi:
                    window -= col_sum[lo]
                    lo += 1
                if window == TARGET_SUM:
                    ncells = sum(
                        1
                        for rr in range(r1, r2 + 1)
                        for cc in range(lo, hi + 1)
                        if board[rr][cc] != 0
                    )
                    if ncells:
                        candidates.append((r1, lo, r2, hi, ncells))
    if not candidates:
        return None
    # Weight ~ 1/ncells^2 so 2-cell clears dominate, big ones are rare.
    weights = [1.0 / (cand[4] ** 2) for cand in candidates]
    pick = rng.choices(candidates, weights=weights, k=1)[0]
    return (pick[0], pick[1], pick[2], pick[3])
