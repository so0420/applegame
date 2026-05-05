"""WebSocket message schemas (loose, dict-based)."""
from __future__ import annotations

from typing import Any

# Client message types
HELLO = "hello"          # {nickname, intent: solo|create|join|match, code?}
START = "start"          # {} (host triggers in friend; auto in others)
DRAG_UPDATE = "drag_update"  # {r1,c1,r2,c2}
SUBMIT = "submit"        # {r1,c1,r2,c2}
REMATCH = "rematch"      # {}
LEAVE = "leave"          # {}

# Server message types
JOINED = "joined"             # {player_id, room}
PEER_JOINED = "peer_joined"   # {player}
PEER_LEFT = "peer_left"       # {player_id}
ROOM_FULL = "room_full"       # {}
NOT_FOUND = "not_found"       # {}
QUEUED = "queued"             # {position}
GAME_START = "game_start"     # {board, ends_at}
PEER_DRAG = "peer_drag"       # {player_id, r1,c1,r2,c2}
CLEAR = "clear"               # {player_id, cells, scores}
REJECT = "reject"             # {reason}
GAME_END = "game_end"         # {scores, winner_id}
ERROR = "error"               # {code, message}


def msg(type_: str, **payload: Any) -> dict[str, Any]:
    return {"type": type_, **payload}
