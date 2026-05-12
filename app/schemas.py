"""WebSocket message schemas (loose, dict-based)."""
from __future__ import annotations

from typing import Any

# Client message types
HELLO = "hello"          # {nickname?, intent: solo|create|join|match, code?}
RENAME = "rename"        # {nickname}
SET_CAPACITY = "set_capacity"  # {capacity} (host only, waiting state)
SET_VARIANT = "set_variant"    # {variant} classic|items (host only, waiting state)
START = "start"          # {} (host triggers in friend; auto in others)
DRAG_UPDATE = "drag_update"  # {r1,c1,r2,c2}
SUBMIT = "submit"        # {r1,c1,r2,c2}
USE_ITEM = "use_item"    # {slot} 0|1 (items variant only)
REMATCH = "rematch"      # {}
LEAVE = "leave"          # {}

# Server message types
JOINED = "joined"             # {player_id, room}
PEER_JOINED = "peer_joined"   # {player}
PEER_LEFT = "peer_left"       # {player_id}
PEER_DISCONNECTED = "peer_disconnected"  # {player_id}
PEER_RECONNECTED = "peer_reconnected"    # {player_id}
RECONNECTED = "reconnected"   # full state on successful reconnect
RENAMED = "renamed"           # {player_id, nickname}
CAPACITY_CHANGED = "capacity_changed"  # {capacity}
VARIANT_CHANGED = "variant_changed"    # {variant}
ROOM_RESET = "room_reset"     # {room} — friend room returned to lobby for next round
MATCH_COUNTDOWN = "match_countdown"  # {deadline_ms} when game starts (random match)
MATCH_COUNTDOWN_CANCEL = "match_countdown_cancel"  # countdown aborted
ROOM_FULL = "room_full"       # {}
NOT_FOUND = "not_found"       # {}
QUEUED = "queued"             # {position}
GAME_START = "game_start"     # {board, ends_at, variant, golden?}
PEER_DRAG = "peer_drag"       # {player_id, r1,c1,r2,c2}
CLEAR = "clear"               # {player_id, cells, scores, gold_hit?}
REJECT = "reject"             # {reason}
GAME_END = "game_end"         # {scores, winner_id}
ERROR = "error"               # {code, message}
# Item-mode messages
GOLDEN_SPAWN = "golden_spawn"     # {player_id, r, c}
ITEM_ACQUIRED = "item_acquired"   # {player_id, slot, item}
ITEM_USED = "item_used"           # {by, item, target_id?}
EFFECT_START = "effect_start"     # {target_id, effect, until_ms, hint?: [{r,c}, ...]}
EFFECT_END = "effect_end"         # {target_id, effect}
BOARD_UPDATE = "board_update"     # {target_id, board} — after shuffle


def msg(type_: str, **payload: Any) -> dict[str, Any]:
    return {"type": type_, **payload}
