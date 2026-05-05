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
