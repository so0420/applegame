import { GameSocket } from "./ws.js";
import { BoardRenderer } from "./board.js";
import { attachDragInput } from "./input.js";
import { audio } from "./audio.js";
import { icon, setIcon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const GAME_DURATION_MS = 120 * 1000;

const screens = {
  home: $("home"),
  helpScreen: $("helpScreen"),
  feedbackScreen: $("feedbackScreen"),
  joinScreen: $("joinScreen"),
  matchVariantScreen: $("matchVariantScreen"),
  lobby: $("lobby"),
  game: $("game"),
};

// Fill every [data-icon="name"] element with its inline SVG. Declarative
// so static chrome (home/menu/mode glyphs) stays in the markup while the
// SVG source lives in icons.js.
function hydrateStaticIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    setIcon(el, el.dataset.icon);
  }
}
hydrateStaticIcons();

function show(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
  // Tells the rotate-prompt media query whether we're on the game screen
  document.body.classList.toggle("on-game", name === "game");
}
function allScreensHidden() {
  return Object.values(screens).every((el) => el.hidden);
}

const state = {
  ws: null,
  playerId: null,
  room: null,
  endsAt: null,
  startedAt: null,
  timerInterval: null,
  progressInterval: null,
  myScore: 0,
  myName: "나",
  hostId: null,
  mode: null,
  variant: "classic",
  intent: null,
  bigRenderer: null,
  miniRenderers: new Map(),
  lbItems: new Map(),
  initialBoard: null,
  events: [],
  scores: {},
  replayActive: false,
  replayTime: 0,
  replaySpeed: 4,
  replayPaused: false,
  replayRafId: null,
  replayLastTick: 0,
  replayCumScores: {},
  focusedPlayerId: null,
  gameWinnerId: null,
  matchDeadlineMs: null,
  matchTickerId: null,
  // Item-mode local state
  inventory: [null, null, null],
  effects: { shield: 0, blind: 0, hint: 0, overload: 0, freeze: 0 },  // expiry ms
  effectTimers: {},
  initialGolden: [],   // [[r,c], ...] picked at game start
  combo: 0,
  // True when watching a friend room we joined mid-round. No board of our
  // own; input is disabled and we get promoted to a player next lobby.
  isSpectator: false,
  // Team mode: the board OWNER for the local player. In team mode this is
  // the team id (teammates share it); otherwise it equals playerId. All
  // board / score / effect ownership checks key on ownerId.
  ownerId: null,
  teams: null,   // [{id, members:[{id,nickname,is_bot}]}, ...] in team mode
};

// Owner id for a player id: their team in team mode, else the player itself.
function ownerOf(playerId) {
  if (state.variant === "team" && Array.isArray(state.teams)) {
    const t = state.teams.find((tm) => tm.members.some((m) => m.id === playerId));
    if (t) return t.id;
  }
  return playerId;
}

// The leaderboard "units" — teams in team mode, else players. Each entry:
// {id, name, members:[playerId...], isMe}.
function leaderboardUnits() {
  if (state.variant === "team" && Array.isArray(state.teams)) {
    return state.teams.map((t) => ({
      id: t.id,
      name: t.members.map((m) => m.nickname).join(" & "),
      members: t.members.map((m) => m.id),
      isMe: t.id === state.ownerId,
    }));
  }
  const players = state.room?.players ?? [];
  return players.map((p) => ({
    id: p.id,
    name: p.nickname,
    members: [p.id],
    isMe: p.id === state.playerId,
  }));
}

// Display name for a board owner id (team name or player nickname).
function ownerName(ownerId) {
  const u = leaderboardUnits().find((x) => x.id === ownerId);
  return u ? u.name : "?";
}

// Inventory capacity: 4 shared slots in team mode, else 3.
function invSize() { return state.variant === "team" ? 4 : 3; }
function invSlots() { return new Array(invSize()).fill(null); }

// `role` groups items for the help screen: self (자기 강화) / attack (공격)
// / defense (방어). Display order below is the order shown in help.
const ITEM_META = {
  hint:     { label: "힌트",  attack: false, role: "self",    desc: "내 보드에 합10 쌍 강조 (3초)" },
  shuffle:  { label: "셔플",  attack: false, role: "self",    desc: "내 보드 남은 사과 무작위 재배치" },
  blind:    { label: "숫자 숨김", attack: true,  role: "attack",  desc: "상대 1명의 숫자를 3초간 가림" },
  overload: { label: "과부하", attack: true,  role: "attack",  desc: "상대 1명의 숫자가 3초간 +1로 잘못 보임 (실제 값은 그대로)" },
  freeze:   { label: "결빙",  attack: true,  role: "attack",  desc: "상대 1명의 조작을 2초간 잠금" },
  shield:   { label: "방어",  attack: false, role: "defense", desc: "8초간 받는 공격 무효 + 적용된 방해 즉시 해제" },
};
// Order items appear in the help list.
const ITEM_ORDER = ["hint", "shuffle", "blind", "overload", "freeze", "shield"];

// Rank-tier drop weights — MIRROR of ITEM_DROP_WEIGHTS in app/game/room.py.
// Used only to render the help screen's drop-rate table; the server is the
// source of truth for actual drops. Keep the two in sync.
const ITEM_DROP_WEIGHTS = {
  top:    { hint: 4, shuffle: 1, blind: 4, overload: 3, freeze: 2, shield: 6 },
  middle: { hint: 3, shuffle: 3, blind: 5, overload: 4, freeze: 3, shield: 2 },
  bottom: { hint: 7, shuffle: 6, blind: 2, overload: 2, freeze: 2, shield: 1 },
};

// Build "icon + text" markup for a toast/tooltip. `name` keys into icons.js
// (item kind or a chrome glyph); falls back to text-only when unknown.
function labelWithIcon(name, text) {
  return `${icon(name)}<span>${text}</span>`;
}

const sumBadge = $("sumBadge");
const canvas = $("board");
state.bigRenderer = new BoardRenderer(canvas);

// Queue of submits awaiting server confirmation. Used to (a) skip the
// re-apply when our own clear comes back and (b) roll the optimistic
// apply back on reject.
state._pendingSubmits = [];

function isRoundOver() {
  // True once the round timer has elapsed. Used to gate input after
  // game_end so closing the replay doesn't reopen play on a finished room.
  return !!(state.endsAt && Date.now() >= state.endsAt);
}

function isFrozen() {
  // The "freeze" attack locks drag/submit for its duration.
  return state.effects.freeze > Date.now();
}

attachDragInput(canvas, state.bigRenderer, {
  onUpdate: (rect) => {
    if (state.replayActive) return;
    if (isRoundOver() || isFrozen()) {
      sumBadge.hidden = true;
      return;
    }
    if (state.focusedPlayerId !== state.ownerId) return; // viewing only
    if (state.startedAt && Date.now() < state.startedAt) {
      sumBadge.hidden = true;
      return;  // pre-game countdown — drags don't fire
    }
    state.ws?.send("drag_update", rect);
    // Blind effect must also hide the running sum — otherwise the player
    // can read the hidden values straight off the drag badge.
    const blinded = state.effects.blind > Date.now();
    if (blinded) {
      sumBadge.hidden = true;
    } else {
      const sum = state.bigRenderer.sumIn(rect);
      sumBadge.hidden = false;
      sumBadge.textContent = String(sum);
      sumBadge.classList.toggle("ten", sum === 10);
      const center = state.bigRenderer.rectCenter(rect);
      if (center) {
        sumBadge.style.left = center.x + "px";
        sumBadge.style.top = center.y + "px";
      }
    }
    // Mirror onto my own (team's) mini so the leaderboard shows my live drag
    state.miniRenderers.get(state.ownerId)?.setMyDrag(rect);
  },
  onSubmit: (rect) => {
    sumBadge.hidden = true;
    if (state.replayActive) return;
    if (isRoundOver() || isFrozen()) return;
    if (state.focusedPlayerId !== state.ownerId) return;
    if (state.startedAt && Date.now() < state.startedAt) return;

    // Tally the rect locally first. If it doesn't sum to 10, don't even
    // bother the server — it would only respond with REJECT and the
    // round trip is wasted traffic. Server-side validation still happens
    // on what we do send, so this is purely a client-side optimisation.
    const board = state.bigRenderer.board;
    const cellsWithValue = [];
    let total = 0;
    if (board) {
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          const v = board[r]?.[c] ?? 0;
          if (v > 0) {
            total += v;
            cellsWithValue.push({ r, c, value: v });
          }
        }
      }
    }
    if (total !== 10 || cellsWithValue.length === 0) return;

    // Optimistic local clear — apply immediately so the apples vanish
    // without waiting for the network round trip. Server stays
    // authoritative; on reject we roll back via restoreCells (which
    // can still happen if the client's board view is stale vs server).
    const arr = cellsWithValue.map((c) => [c.r, c.c]);
    state.bigRenderer.clearCells(arr);
    state.miniRenderers.get(state.ownerId)?.clearCells(arr);
    state._pendingSubmits.push({ cells: cellsWithValue, applied: true });
    state.ws?.send("submit", rect);
  },
});

// ---- Session persistence for reconnect ----
const SESSION_KEY = "apple-session";
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function saveSession() {
  if (!state.playerId || !state.room?.id) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      player_id: state.playerId,
      room_id: state.room.id,
      ts: Date.now(),
    }));
  } catch {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s.player_id || !s.room_id) return null;
    if (Date.now() - (s.ts || 0) > SESSION_MAX_AGE_MS) return null;
    return s;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ---- Auto-actions on page load ----
// Home is hidden by default in HTML so we don't flash it during a
// reconnect attempt. Bootstrap is responsible for revealing whichever
// screen is appropriate.
(async function bootstrap() {
  // 1) Try resuming an in-progress game first
  const sess = loadSession();
  if (sess) {
    state.ws = new GameSocket();
    bindSocket(state.ws);
    try {
      await state.ws.connect();
      state.ws.send("hello", {
        intent: "reconnect",
        player_id: sess.player_id,
        room_id: sess.room_id,
      });
      return; // success/failure handlers will pick the screen
    } catch {
      clearSession();
    }
  }
  // 2) Else, fall back to ?room=XXXXXX auto-join
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || "").trim().toUpperCase();
  if (code.length === 6) {
    history.replaceState(null, "", location.pathname);
    await startSession("join", code);
    return;
  }
  // 3) Nothing to do — show home
  show("home");
})();

// ---- Home screen ----
document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", async () => {
    // Variant-pick buttons inside #matchVariantScreen are also `.mode`
    // chips — skip them here, they have their own handler below.
    if (btn.dataset.matchVariant) return;
    const intent = btn.dataset.intent;
    if (intent === "join-open") {
      $("joinCode").value = "";
      show("joinScreen");
      $("joinCode").focus();
      return;
    }
    if (intent === "match") {
      show("matchVariantScreen");
      return;
    }
    await startSession(intent);
  });
});

// Random-match variant pickers
document.querySelectorAll("[data-match-variant]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const v = btn.dataset.matchVariant;
    const variant = (v === "items" || v === "team") ? v : "classic";
    await startSession("match", null, variant);
  });
});
$("matchVariantBackBtn")?.addEventListener("click", () => show("home"));

// ---- Help screen ----
$("helpOpenBtn")?.addEventListener("click", () => { renderHelpItems(); show("helpScreen"); });
$("helpBackBtn")?.addEventListener("click", () => show("home"));

// ---- Feedback / 문의 ----
$("feedbackOpenBtn")?.addEventListener("click", () => {
  $("feedbackMessage").value = "";
  $("feedbackContact").value = "";
  $("feedbackToast").hidden = true;
  show("feedbackScreen");
  $("feedbackMessage").focus();
});
$("feedbackBackBtn")?.addEventListener("click", () => show("home"));
$("feedbackSubmit")?.addEventListener("click", submitFeedback);

async function submitFeedback() {
  const message = $("feedbackMessage").value.trim();
  const contact = $("feedbackContact").value.trim();
  const toast = $("feedbackToast");
  const btn = $("feedbackSubmit");
  const fail = (text) => {
    toast.textContent = text;
    toast.style.color = "var(--danger)";
    toast.hidden = false;
  };
  if (message.length < 2) {
    fail("내용을 2자 이상 입력해 주세요.");
    return;
  }
  btn.disabled = true;
  try {
    const resp = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, contact }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      toast.textContent = "문의가 접수되었습니다. 감사합니다!";
      toast.style.color = "";
      toast.hidden = false;
      $("feedbackMessage").value = "";
      $("feedbackContact").value = "";
      setTimeout(() => { if (!screens.feedbackScreen.hidden) show("home"); }, 1400);
    } else if (resp.status === 429) {
      fail("문의가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
    } else {
      fail("전송에 실패했습니다. 다시 시도해 주세요.");
    }
  } catch {
    fail("네트워크 오류로 전송하지 못했습니다.");
  } finally {
    btn.disabled = false;
  }
}

// Render the help-screen item table (icon · name · role · desc · per-tier
// drop %). Percentages are derived from the ITEM_DROP_WEIGHTS mirror.
const ROLE_LABEL = { self: "자기 강화", attack: "공격", defense: "방어" };
function renderHelpItems() {
  const list = $("helpItemList");
  if (!list) return;
  const pct = (tier, k) => {
    const w = ITEM_DROP_WEIGHTS[tier];
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    return Math.round((w[k] / total) * 100);
  };
  list.innerHTML = ITEM_ORDER.map((k) => {
    const m = ITEM_META[k];
    const iconCls = m.attack ? "help-icon attack" : "help-icon";
    return `
      <li>
        <span class="${iconCls}">${icon(k)}</span>
        <span class="help-body">
          <span class="help-title"><strong>${m.label}</strong>
            <span class="role-tag ${m.role}">${ROLE_LABEL[m.role]}</span></span>
          <span class="help-desc">${m.desc}</span>
          <span class="help-prob">
            <span>하위 <b>${pct("bottom", k)}%</b></span>
            <span>중위 <b>${pct("middle", k)}%</b></span>
            <span>상위 <b>${pct("top", k)}%</b></span>
          </span>
        </span>
      </li>`;
  }).join("");
}

// ---- Audio: unlock on first user gesture, wire mute toggle ----
function refreshAudioToggleUi() {
  const btn = $("audioToggle");
  if (!btn) return;
  btn.classList.toggle("muted", audio.muted);
  setIcon(btn, audio.muted ? "audioOff" : "audioOn");
}
refreshAudioToggleUi();
const _unlockOnce = () => {
  audio.unlock();
  window.removeEventListener("pointerdown", _unlockOnce, true);
  window.removeEventListener("keydown", _unlockOnce, true);
};
window.addEventListener("pointerdown", _unlockOnce, true);
window.addEventListener("keydown", _unlockOnce, true);
$("audioToggle")?.addEventListener("click", () => {
  audio.unlock();
  audio.toggleMuted();
  refreshAudioToggleUi();
});

// Resize all renderers when device orientation changes (rotate-hint → game)
window.matchMedia("(orientation: portrait)").addEventListener("change", () => {
  requestAnimationFrame(() => {
    state.bigRenderer?.resize();
    for (const r of state.miniRenderers.values()) r.resize();
  });
});

// ---- Lobby capacity input (host only, friend mode) ----
const capacityInput = $("capacityInput");
function commitCapacity() {
  let v = parseInt(capacityInput.value, 10);
  if (Number.isNaN(v)) v = state.room?.capacity ?? 10;
  v = Math.max(2, Math.min(50, v));
  capacityInput.value = String(v);
  state.ws?.send("set_capacity", { capacity: v });
}
capacityInput.addEventListener("change", commitCapacity);
capacityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    capacityInput.blur();
  }
});

// ---- Lobby variant toggle (host only, friend mode) ----
document.querySelectorAll(".variant-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const v = btn.dataset.variant;
    if (!v || v === state.variant) return;
    state.ws?.send("set_variant", { variant: v });
  });
});

// ---- Inventory click ----
function discardSlot(slot) {
  if (!Number.isInteger(slot)) return;
  if (!state.inventory[slot]) return;
  if (state.replayActive || isRoundOver()) return;
  hideInvTooltip();
  state.ws?.send("discard_item", { slot });
}

// Use the item in `slot`, applying the same guards as a slot click
// (shared by the click handler and the number-key hotkeys).
function useItemSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= invSize()) return;
  if ((state.variant !== "items" && state.variant !== "team") || state.isSpectator) return;
  const item = state.inventory[slot];
  if (!item) return;
  if (state.replayActive || isRoundOver()) return;
  const remaining = state.endsAt ? state.endsAt - Date.now() : 0;
  const locked = remaining > 0 && remaining <= 10_000;
  if (ITEM_META[item]?.attack && locked) {
    showItemToast("<span>⏳ 마지막 10초엔 공격 아이템을 쓸 수 없어요</span>");
    return;
  }
  hideInvTooltip();
  state.ws?.send("use_item", { slot });
}

document.querySelectorAll(".inv-slot").forEach((btn) => {
  btn.addEventListener("click", (ev) => {
    const slot = parseInt(btn.dataset.slot, 10);
    if (!Number.isInteger(slot)) return;
    if (!state.inventory[slot]) return;
    if (state.replayActive || isRoundOver()) return;
    // ✕ corner click → discard instead of use. Use closest() because the
    // click can land on the SVG (or a path inside it) nested in .inv-x.
    if (ev.target.closest?.(".inv-x")) {
      ev.stopPropagation();
      discardSlot(slot);
      return;
    }
    useItemSlot(slot);
  });
  // Right-click → discard (desktop).
  btn.addEventListener("contextmenu", (ev) => {
    const slot = parseInt(btn.dataset.slot, 10);
    if (!Number.isInteger(slot) || !state.inventory[slot]) return;
    ev.preventDefault();
    discardSlot(slot);
  });
  // Long-press → discard (mobile). 550ms threshold to avoid clashing
  // with the tap-to-use gesture.
  let pressTimer = null;
  let longPressed = false;
  btn.addEventListener("touchstart", () => {
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      const slot = parseInt(btn.dataset.slot, 10);
      if (state.inventory[slot]) {
        longPressed = true;
        if (navigator.vibrate) navigator.vibrate(15);
        discardSlot(slot);
      }
    }, 550);
  }, { passive: true });
  const cancelLong = () => clearTimeout(pressTimer);
  btn.addEventListener("touchend", (ev) => {
    cancelLong();
    if (longPressed) {
      // Swallow the trailing click so use_item doesn't also fire.
      ev.preventDefault();
    }
  });
  btn.addEventListener("touchmove", cancelLong, { passive: true });
  btn.addEventListener("touchcancel", cancelLong);
});

// ---- Inventory hover tooltip (desktop only — mobile rotated UI has no
// reliable hover signal so we just skip it there). ----
const invTooltip = $("invTooltip");
const invTooltipName = invTooltip.querySelector(".inv-tooltip-name");
const invTooltipDesc = invTooltip.querySelector(".inv-tooltip-desc");
function showInvTooltipFor(btn) {
  const slot = parseInt(btn.dataset.slot, 10);
  if (!Number.isInteger(slot)) return;
  const item = state.inventory[slot];
  const meta = item ? ITEM_META[item] : null;
  if (!meta) return;
  invTooltipName.innerHTML = `${icon(item)}<span>${meta.label}</span>`;
  invTooltipDesc.textContent = meta.desc;
  invTooltip.hidden = false;
  // Position above the slot. -8px lifts it off the slot a hair so the
  // CSS arrow doesn't overlap the item icon.
  const rect = btn.getBoundingClientRect();
  invTooltip.style.left = (rect.left + rect.width / 2) + "px";
  invTooltip.style.top = (rect.top - 8) + "px";
}
function hideInvTooltip() {
  invTooltip.hidden = true;
}
// Only desktop inventory binds hover — mobile rotated overlay uses tap
// to use, and hover events on touch are unreliable / hijack the tap.
document.querySelectorAll("#inventory .inv-slot").forEach((btn) => {
  btn.addEventListener("mouseenter", () => showInvTooltipFor(btn));
  btn.addEventListener("mouseleave", hideInvTooltip);
  btn.addEventListener("focus", () => showInvTooltipFor(btn));
  btn.addEventListener("blur", hideInvTooltip);
});

// ---- Item hotkeys: 1/2/3 use, Shift+1/2/3 OR Space+1/2/3 discard ----
// Uses e.code (layout-independent, unaffected by Shift) so Shift+1 still
// maps to slot 0 instead of arriving as "!". Space is a held discard
// modifier (alternative to Shift) — tracked here since it isn't a real
// modifier key.
const HOTKEY_SLOT = {
  Digit1: 0, Numpad1: 0,
  Digit2: 1, Numpad2: 1,
  Digit3: 2, Numpad3: 2,
  Digit4: 3, Numpad4: 3,   // 4th slot — team mode only
};
let spaceHeld = false;
function onItemsGameScreen() {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return false;  // don't hijack typing
  const itemy = state.variant === "items" || state.variant === "team";
  return !screens.game.hidden && itemy && !state.isSpectator;
}
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    // Hold Space as a discard modifier. preventDefault stops the page from
    // scrolling / a focused button from activating while it's held.
    if (onItemsGameScreen()) {
      spaceHeld = true;
      e.preventDefault();
    }
    return;
  }
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  const slot = HOTKEY_SLOT[e.code];
  if (slot === undefined) return;
  if (!onItemsGameScreen()) return;
  e.preventDefault();
  if (e.shiftKey || spaceHeld) discardSlot(slot);
  else useItemSlot(slot);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceHeld = false;
});
// Holding Space then alt-tabbing away never fires keyup — clear on blur.
window.addEventListener("blur", () => { spaceHeld = false; });

// Join screen
$("joinBackBtn").addEventListener("click", () => show("home"));
$("joinSubmit").addEventListener("click", () => submitJoinCode());
$("joinCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitJoinCode();
  }
});

async function submitJoinCode() {
  const code = $("joinCode").value.trim().toUpperCase();
  if (code.length !== 6) {
    alert("6자리 코드를 입력하세요.");
    return;
  }
  await startSession("join", code);
}

async function startSession(intent, code = null, variant = null) {
  state.intent = intent;
  state.ws = new GameSocket();
  bindSocket(state.ws);
  await state.ws.connect();
  const hello = { intent, code };
  if (variant) hello.variant = variant;
  state.ws.send("hello", hello);

  $("lobbyTitle").textContent =
    intent === "match" ? "랜덤 매칭 중" :
    intent === "solo" ? "혼자 연습 시작" :
    intent === "create" ? "방 만들기" : "방 입장";
  $("lobbyMsg").textContent = intent === "match" ? "상대를 찾고 있습니다." : "잠시만 기다려 주세요.";
  $("startBtn").hidden = true;
  $("roomCode").textContent = "------";
  $("playerList").innerHTML = "";
  $("copyToast").hidden = true;
  $("roomCodeSection").hidden = (intent === "solo" || intent === "match");
  show("lobby");
}

// ---- Lobby actions ----
$("cancelBtn").addEventListener("click", () => leaveAndGoHome());
$("homeBtn").addEventListener("click", () => leaveAndGoHome());
$("startBtn").addEventListener("click", () => state.ws?.send("start"));
function triggerRematch() {
  exitReplay();
  if (state.mode === "random") {
    // Random rooms have no host and don't reuse the room — push the
    // player straight back into matchmaking with the same variant, as if
    // they had hit "랜덤 매칭" from the home screen again.
    const variant = (state.variant === "items" || state.variant === "team")
      ? state.variant : "classic";
    audio.stopBgm();
    if (state._bgmStartTimer) {
      clearTimeout(state._bgmStartTimer);
      state._bgmStartTimer = null;
    }
    // Mark the close as expected so the bound close handler doesn't
    // pop the "연결이 종료되었습니다" reload alert.
    state._intentionalClose = true;
    state.ws?.send("leave");
    state.ws?.close();
    clearSession();
    resetState();
    startSession("match", null, variant);
    return;
  }
  state.ws?.send("rematch");
}
$("rematchBtn").addEventListener("click", triggerRematch);
$("mobileRematchBtn").addEventListener("click", triggerRematch);

// Drawer toggle (mobile) — desktop drawer button + mobile-overlay corner button
$("drawerToggle").addEventListener("click", () => {
  screens.game.classList.toggle("drawer-open");
});
$("drawerBackdrop").addEventListener("click", () => {
  screens.game.classList.remove("drawer-open");
});
$("cornerDrawerBtn").addEventListener("click", () => {
  screens.game.classList.toggle("drawer-open");
});
function confirmAndGoHome() {
  // Confirm before tearing down a live match. Skip the prompt once the
  // round is already over (result banner / replay).
  const inPlay = state.endsAt && Date.now() < state.endsAt && !state.replayActive;
  if (inPlay && !confirm("정말 나가시겠어요? 진행 중인 게임이 중단됩니다.")) return;
  leaveAndGoHome();
}
$("cornerHomeBtn").addEventListener("click", confirmAndGoHome);
$("gameHomeBtn")?.addEventListener("click", confirmAndGoHome);

// In-place nickname editing inside the lobby player list. Replaces the
// dedicated "내 닉네임" section that used to sit above the list.
function beginNicknameEdit(li, nameSpan) {
  if (li.querySelector("input.nick-edit-input")) return;  // already editing
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nick-edit-input";
  input.maxLength = 20;
  input.value = state.myName;
  input.autocomplete = "off";
  input.placeholder = "닉네임";

  const commit = () => {
    const v = input.value.trim().slice(0, 20);
    if (v && v !== state.myName) {
      state.ws?.send("rename", { nickname: v });
      state.myName = v;
      nameSpan.textContent = v + " (나)";
    }
    li.replaceChild(nameSpan, input);
  };
  const cancel = () => {
    li.replaceChild(nameSpan, input);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      cancel();
    }
  });
  input.addEventListener("blur", commit);

  li.replaceChild(input, nameSpan);
  input.focus();
  input.select();
}

// Host editing another player's nickname inline. Sends host_rename; the
// broadcast 'renamed' re-renders the lobby with the new name.
function beginHostNicknameEdit(li, nameSpan, targetId) {
  if (li.querySelector("input.nick-edit-input")) return;  // already editing
  const player = state.room?.players.find((p) => p.id === targetId);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nick-edit-input";
  input.maxLength = 20;
  input.value = player?.nickname ?? "";
  input.autocomplete = "off";
  input.placeholder = "닉네임";

  const commit = () => {
    const v = input.value.trim().slice(0, 20);
    if (v && v !== player?.nickname) {
      state.ws?.send("host_rename", { player_id: targetId, nickname: v });
      nameSpan.textContent = v;
    }
    li.replaceChild(nameSpan, input);
  };
  const cancel = () => { li.replaceChild(nameSpan, input); };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      cancel();
    }
  });
  input.addEventListener("blur", commit);

  li.replaceChild(input, nameSpan);
  input.focus();
  input.select();
}

$("copyCodeBtn").addEventListener("click", () => {
  const code = state.room?.id;
  if (!code) return;
  copyText(code, "코드를 복사했습니다.");
});

$("copyLinkBtn").addEventListener("click", () => {
  const code = state.room?.id;
  if (!code) return;
  const link = `${location.origin}/?room=${code}`;
  copyText(link, "초대 링크를 복사했습니다.");
});

async function copyText(text, successMsg) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  const toast = $("copyToast");
  toast.textContent = ok ? successMsg : "복사에 실패했습니다.";
  toast.style.color = ok ? "" : "var(--danger)";
  toast.hidden = false;
  clearTimeout(state._toastTimer);
  state._toastTimer = setTimeout(() => { toast.hidden = true; }, 2000);
}

function leaveAndGoHome() {
  exitReplay();
  audio.stopBgm();
  if (state._bgmStartTimer) {
    clearTimeout(state._bgmStartTimer);
    state._bgmStartTimer = null;
  }
  $("resultBanner").hidden = true;
  $("mobileResultActions").hidden = true;
  state._intentionalClose = true;
  state.ws?.send("leave");
  state.ws?.close();
  clearSession();
  resetState();
  show("home");
}

function resetState() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.timerInterval = null;
  state.progressInterval = null;
  state.ws = null;
  state.playerId = null;
  state.room = null;
  state.endsAt = null;
  state.startedAt = null;
  state.myScore = 0;
  state.myName = "나";
  state.events = [];
  state.scores = {};
  state.initialBoard = null;
  state.focusedPlayerId = null;
  state.gameWinnerId = null;
  state.matchDeadlineMs = null;
  state.variant = "classic";
  state.teams = null;
  state.ownerId = null;
  state.inventory = [null, null, null];
  state.effects = { shield: 0, blind: 0, hint: 0, overload: 0, freeze: 0 };
  state.initialGolden = [];
  state.isSpectator = false;
  $("inventory").hidden = true;
  $("mobileInventory").hidden = true;
  $("invTooltip").hidden = true;
  $("noMovesBadge").hidden = true;
  $("spectateBanner").hidden = true;
  document.querySelectorAll(".board-effect-overlay").forEach((el) => el.remove());
  if (state.matchTickerId) {
    clearInterval(state.matchTickerId);
    state.matchTickerId = null;
  }
  if (state._peerDragTimers) {
    for (const t of state._peerDragTimers.values()) clearTimeout(t);
    state._peerDragTimers.clear();
  }
  for (const r of state.miniRenderers.values()) r.dispose?.();
  state.miniRenderers.clear();
  state.lbItems.clear();
  $("lbList").innerHTML = "";
  $("progressFill").style.width = "0%";
  $("verticalProgressFill").style.width = "0%";
  $("miniScore").textContent = "0";
  $("miniTimer").textContent = "2:00";
  $("resultBanner").hidden = true;
  $("mobileResultActions").hidden = true;
  $("topProgress").hidden = false;
  $("focusLabel").hidden = true;
  screens.game.classList.remove("drawer-open");
}

// ---- Socket bindings ----
function bindSocket(ws) {
  ws.addEventListener("close", () => {
    // Intentional teardown by the client (leaveAndGoHome, random rematch
    // re-queue, etc.) — swallow without alarming the user. The flag lives
    // on `state` so it survives ws-replacement during transitions.
    if (state._intentionalClose) {
      state._intentionalClose = false;
      return;
    }
    // If the close came before any screen was shown (e.g. reconnect
    // attempt aborted), default to home.
    if (allScreensHidden()) {
      show("home");
      return;
    }
    // Home screen has no live connection responsibility — silent close
    // is the expected path after leaveAndGoHome().
    if (!screens.home.hidden) return;
    // Game/lobby was live and the socket dropped — usually a server
    // restart or network blip. Reload the page so the user picks up
    // the latest HTML/JS before reconnecting, instead of letting
    // an outdated client talk to the new server.
    alert("연결이 종료되었습니다. 페이지를 새로고침합니다.");
    location.reload();
  });

  ws.addEventListener("msg:joined", (e) => {
    const m = e.detail;
    state.playerId = m.player_id;
    onRoomUpdate(m.room);
    const me = m.room.players.find((p) => p.id === state.playerId);
    if (me) state.myName = me.nickname;
  });

  ws.addEventListener("msg:peer_joined", (e) => {
    const p = e.detail.player;
    if (state.room) {
      const existing = state.room.players.find((x) => x.id === p.id);
      if (!existing) state.room.players.push(p);
    }
    renderLobby();
  });

  ws.addEventListener("msg:peer_left", (e) => {
    if (!state.room) return;
    state.room.players = state.room.players.filter((p) => p.id !== e.detail.player_id);
    renderLobby();
  });

  ws.addEventListener("msg:renamed", (e) => {
    const { player_id, nickname } = e.detail;
    if (!state.room) return;
    const p = state.room.players.find((x) => x.id === player_id);
    if (p) p.nickname = nickname;
    if (player_id === state.playerId) state.myName = nickname;
    const item = state.lbItems.get(player_id);
    if (item) item.nameEl.textContent = nickname + (player_id === state.playerId ? " (me)" : "");
    renderLobby();
  });

  ws.addEventListener("msg:capacity_changed", (e) => {
    const cap = e.detail.capacity;
    if (state.room) state.room.capacity = cap;
    if (document.activeElement !== capacityInput) {
      capacityInput.value = String(cap);
    }
    renderLobby();
  });

  ws.addEventListener("msg:variant_changed", (e) => {
    state.variant = e.detail.variant || "classic";
    if (state.room) state.room.variant = state.variant;
    renderLobby();
  });

  ws.addEventListener("msg:item_acquired", (e) => {
    const { slot, item } = e.detail;
    state.inventory[slot] = item;
    renderInventory();
    const meta = ITEM_META[item];
    if (meta) showItemToast(labelWithIcon(item, `${meta.label} 획득!`));
  });

  ws.addEventListener("msg:item_discarded", (e) => {
    const { slot } = e.detail;
    if (typeof slot === "number") {
      state.inventory[slot] = null;
      renderInventory();
      showItemToast(labelWithIcon("discard", "아이템 버림"));
    }
  });

  ws.addEventListener("msg:item_used", (e) => {
    const { by, item, target_id, slot, t_ms, blocked } = e.detail;
    state.events.push({
      kind: "item_used", t_ms: t_ms ?? 0, by, item, target_id, blocked: !!blocked,
    });
    // Server clears the slot — mirror that locally. In team mode the
    // inventory is shared, so a teammate's use empties the slot for me too.
    if (typeof slot === "number" && ownerOf(by) === state.ownerId) {
      state.inventory[slot] = null;
      renderInventory();
    }
    showItemUsedToast(by, item, target_id, !!blocked);
  });

  ws.addEventListener("msg:effect_start", (e) => {
    const { target_id, effect, until_ms, hint, t_ms } = e.detail;
    state.events.push({
      kind: "effect_start", t_ms: t_ms ?? 0,
      target_id, effect, until_ms, hint,
    });
    applyEffectStart(target_id, effect, until_ms, hint);
  });

  ws.addEventListener("msg:effect_end", (e) => {
    const { target_id, effect, t_ms } = e.detail;
    state.events.push({ kind: "effect_end", t_ms: t_ms ?? 0, target_id, effect });
    applyEffectEnd(target_id, effect);
  });

  ws.addEventListener("msg:board_update", (e) => {
    const { target_id, board, t_ms } = e.detail;
    state.events.push({
      kind: "shuffle", t_ms: t_ms ?? 0,
      target_id, board: board.map((row) => row.slice()),
    });
    applyShuffle(target_id, board, /*animate*/ true);
  });

  ws.addEventListener("msg:queued", (e) => {
    $("lobbyMsg").textContent = `매칭 대기열 ${e.detail.position}번째…`;
  });

  ws.addEventListener("msg:match_countdown", (e) => {
    state.matchDeadlineMs = e.detail.deadline_ms;
    renderLobby();
    startMatchCountdownTicker();
  });

  ws.addEventListener("msg:match_countdown_cancel", () => {
    state.matchDeadlineMs = null;
    if (state.matchTickerId) {
      clearInterval(state.matchTickerId);
      state.matchTickerId = null;
    }
    renderLobby();
  });

  ws.addEventListener("msg:not_found", () => {
    // If we got here from a silent reconnect attempt, just go home cleanly
    const fromReconnect = state.playerId === null && state.room === null;
    clearSession();
    if (!fromReconnect) alert("방을 찾을 수 없습니다.");
    leaveAndGoHome();
  });

  ws.addEventListener("msg:room_full", () => {
    alert("방이 가득 찼거나 이미 게임 중입니다.");
    leaveAndGoHome();
  });

  ws.addEventListener("msg:game_start", (e) => {
    onGameStart(e.detail);
    saveSession();
  });

  ws.addEventListener("msg:reconnected", (e) => {
    onReconnected(e.detail);
  });

  ws.addEventListener("msg:spectate", (e) => {
    onSpectate(e.detail);
  });

  ws.addEventListener("msg:kicked", () => {
    // Host removed us. Tear down without the "connection lost" reload path.
    state._intentionalClose = true;
    alert("방장이 당신을 내보냈습니다.");
    try { state.ws?.close(); } catch {}
    clearSession();
    resetState();
    show("home");
  });

  ws.addEventListener("msg:room_reset", (e) => {
    // Friend room came back to the lobby for the next round. A spectator
    // promoted into the roster lands here too — drop the spectator flag so
    // they behave as a normal player from now on.
    state.isSpectator = false;
    $("spectateBanner").hidden = true;
    exitReplay();
    $("resultBanner").hidden = true;
  $("mobileResultActions").hidden = true;
    $("topProgress").hidden = false;
    state.events = [];
    state.scores = {};
    state.gameWinnerId = null;
    for (const r of state.miniRenderers.values()) r.dispose?.();
    state.miniRenderers.clear();
    state.lbItems.clear();
    $("lbList").innerHTML = "";
    $("focusLabel").hidden = true;
    clearSession();
    onRoomUpdate(e.detail.room);
    show("lobby");
  });

  ws.addEventListener("msg:peer_disconnected", (e) => {
    const pid = e.detail.player_id;
    const item = state.lbItems.get(pid);
    if (item) item.li.classList.add("disconnected");
  });

  ws.addEventListener("msg:peer_reconnected", (e) => {
    const pid = e.detail.player_id;
    const item = state.lbItems.get(pid);
    if (item) item.li.classList.remove("disconnected");
  });

  ws.addEventListener("msg:peer_drag", (e) => {
    const { player_id, owner_id, r1, c1, r2, c2 } = e.detail;
    if (player_id === state.playerId) return;  // never echo my own
    const oid = owner_id ?? player_id;          // board this drag draws on
    const rect = { r1, c1, r2, c2 };
    state.miniRenderers.get(oid)?.setMyDrag(rect);
    if (oid === state.focusedPlayerId) {
      state.bigRenderer.setMyDrag(rect);
    }
    // Self-heal: if a peer submits something invalid (server rejects)
    // and never drags again, the last rect would hang on their mini
    // forever — the server doesn't broadcast peer rejects. Auto-clear
    // after a few seconds with no update; the next drag_update will
    // reset the timer.
    if (!state._peerDragTimers) state._peerDragTimers = new Map();
    const prev = state._peerDragTimers.get(oid);
    if (prev) clearTimeout(prev);
    state._peerDragTimers.set(oid, setTimeout(() => {
      state.miniRenderers.get(oid)?.setMyDrag(null);
      if (oid === state.focusedPlayerId) state.bigRenderer.setMyDrag(null);
      state._peerDragTimers?.delete(oid);
    }, 2500));
  });

  ws.addEventListener("msg:clear", (e) => {
    const { cells, scores, player_id, by, t_ms, combo, combo_triggered } = e.detail;
    // player_id is the board OWNER (team id in team mode); `by` is the actor.
    state.events.push({ kind: "clear", t_ms: t_ms ?? 0, player_id, cells });
    const isMyBoard = player_id === state.ownerId;
    const iSubmitted = by === undefined ? player_id === state.playerId : by === state.playerId;
    if (isMyBoard && (state.variant === "items" || state.variant === "team")) {
      setCombo(combo ?? 0, !!combo_triggered);
    }
    if (iSubmitted) {
      // Server confirmation of MY own submit. Pop the matching pending entry;
      // only re-apply if it wasn't done optimistically already.
      const pending = state._pendingSubmits.shift();
      if (!pending?.applied) {
        state.bigRenderer.clearCells(cells);
        state.miniRenderers.get(player_id)?.clearCells(cells);
      }
      state.miniRenderers.get(player_id)?.setMyDrag(null);
      if (isMyBoard) state.bigRenderer.setMyDrag(null);
      audio.clearSfx(cells?.length ?? 0);
    } else {
      // Someone else cleared: a teammate/bot on MY shared board, or another
      // unit's board entirely.
      const mini = state.miniRenderers.get(player_id);
      if (mini) {
        mini.clearCells(cells);
        mini.setMyDrag(null);
      }
      if (isMyBoard) {
        // Teammate / AI cleared on my team's board — mirror onto big board.
        state.bigRenderer.clearCells(cells);
        audio.clearSfx(cells?.length ?? 0);
      } else if (player_id === state.focusedPlayerId) {
        state.bigRenderer.clearCells(cells);
        state.bigRenderer.setMyDrag(null);
      }
      const t = state._peerDragTimers?.get(player_id);
      if (t) {
        clearTimeout(t);
        state._peerDragTimers.delete(player_id);
      }
    }
    state.scores = scores;
    reorderAndRankLeaderboard();
    updateNoMoves();
  });

  ws.addEventListener("msg:reject", () => {
    // Roll back the optimistic apply for the matching pending submit.
    const pending = state._pendingSubmits.shift();
    if (pending?.applied && pending.cells.length > 0) {
      state.bigRenderer.restoreCells(pending.cells);
      state.miniRenderers.get(state.ownerId)?.restoreCells(pending.cells);
      updateNoMoves();
    }
  });

  ws.addEventListener("msg:game_end", (e) => {
    audio.stopBgm();
    if (state._bgmStartTimer) {
      clearTimeout(state._bgmStartTimer);
      state._bgmStartTimer = null;
    }
    showResult(e.detail);
    clearSession();
  });

  ws.addEventListener("msg:error", (e) => {
    if (e.detail.code === "already_connected") {
      // Another tab/window is using this session. Don't clearSession()
      // so the original tab keeps working; just go to home here.
      alert("이미 다른 창에서 접속 중입니다. 한 곳에서만 사용해주세요.");
      try { state.ws?.close(); } catch {}
      // Bypass resetState's clear-on-close path
      state.ws = null;
      state.playerId = null;
      state.room = null;
      show("home");
      return;
    }
    console.warn("server error:", e.detail);
  });
}

// ---- Reconnection ----
function onReconnected(m) {
  state.playerId = m.player_id;
  onRoomUpdate(m.room);
  // Preserve every field — replay & active-effect restoration depend on
  // kind / target_id / effect / until_ms / hint / board fields. The old
  // mapping silently dropped them, which made the replay crash on the
  // first non-clear event after reconnect.
  state.events = (m.events || []).map((e) => ({ ...e }));
  state.scores = m.scores || {};
  state.endsAt = (m.ends_at || 0) * 1000;
  state.startedAt = state.endsAt - GAME_DURATION_MS;
  state.initialBoard = m.initial_board ? m.initial_board.map((row) => row.slice()) : null;

  const me = m.room.players.find((p) => p.id === state.playerId);
  if (me) state.myName = me.nickname;
  // Inventory + combo come from my OWNER (team in team mode, else me).
  const myUnit = state.variant === "team"
    ? (state.teams || []).find((t) => t.id === state.ownerId)
    : me;
  if (myUnit) {
    state.inventory = Array.isArray(myUnit.inventory)
      ? myUnit.inventory.slice(0, invSize())
      : invSlots();
    while (state.inventory.length < invSize()) state.inventory.push(null);
    setCombo(typeof myUnit.combo === "number" ? myUnit.combo : 0);
  }
  renderInventory();
  state.initialGolden = Array.isArray(m.initial_golden)
    ? m.initial_golden.map(([r, c]) => [r, c])
    : [];

  // Build leaderboard, then set each owner's current board state
  buildLeaderboard();
  if (m.boards) {
    for (const [oid, board] of Object.entries(m.boards)) {
      const mini = state.miniRenderers.get(oid);
      if (mini) mini.setBoard(board);
    }
  }
  // Re-stamp goldens that are still in play. Server sends a per-owner
  // dict so partial pickups are honoured rather than reset to the
  // initial set.
  if ((state.variant === "items" || state.variant === "team") && m.golden && typeof m.golden === "object") {
    for (const [pid, cells] of Object.entries(m.golden)) {
      const renderer = state.miniRenderers.get(pid);
      if (!renderer) continue;
      renderer.clearGolden();
      for (const [r, c] of cells) renderer.setGolden(r, c, true);
    }
  }
  // Restore focus to my own board — also copies it onto the big renderer
  // and (critically) re-enables drag input which is gated by
  // focusedPlayerId === ownerId.
  setFocusedPlayer(state.ownerId, /*forceCopy*/ true);
  // Mark currently disconnected peers (non-team only; team rows are shared).
  if (state.variant !== "team") {
    for (const p of m.room.players) {
      if (p.connected === false) {
        const item = state.lbItems.get(p.id);
        if (item) item.li.classList.add("disconnected");
      }
    }
  }
  reorderAndRankLeaderboard();

  if (m.state === "playing") {
    show("game");
    startTimer();
    startProgress();
    maybeShowStartCountdown();
    // Re-apply still-open effects AFTER the countdown step. A reconnect has
    // startedAt in the past, so maybeShowStartCountdown clears the
    // number-hide flag; re-applying here keeps an active blind visible
    // instead of being wiped until its effect_end arrives.
    reapplyOpenEffects();
    scheduleBgmAtRoundStart();
    saveSession();
    requestAnimationFrame(() => {
      state.bigRenderer.resize();
      for (const r of state.miniRenderers.values()) r.resize();
    });
  } else if (m.state === "finished") {
    showResult({ scores: m.scores || {}, winner_id: m.winner_id ?? null });
    clearSession();
  } else {
    show("game");
  }
}

// Re-apply every still-open (started, not yet ended, not expired) timed
// effect from the event log. Shared by reconnect + spectate. Must run AFTER
// maybeShowStartCountdown() so the countdown's number-reveal doesn't wipe a
// genuinely-active blind.
function reapplyOpenEffects() {
  if (state.variant !== "items" && state.variant !== "team") return;
  const nowMs = Date.now();
  const open = new Map();  // "target_id|effect" -> effect_start event
  for (const ev of state.events) {
    if (ev.kind === "effect_start") open.set(`${ev.target_id}|${ev.effect}`, ev);
    else if (ev.kind === "effect_end") open.delete(`${ev.target_id}|${ev.effect}`);
  }
  for (const ev of open.values()) {
    if (ev.until_ms && ev.until_ms <= nowMs) continue;
    applyEffectStart(ev.target_id, ev.effect, ev.until_ms, ev.hint);
  }
}

// ---- Spectator (joined a friend room mid-round) ----
// Builds the live watch view from a state snapshot. Reuses the player
// renderers but disables our own input (we own no board) and shows a
// "관전 중" banner. We get promoted to a real player at the next lobby
// (server side), which arrives as room_reset.
function onSpectate(m) {
  state.isSpectator = true;
  state.playerId = m.player_id;   // matches no board → input self-disables
  onRoomUpdate(m.room);
  state.events = (m.events || []).map((e) => ({ ...e }));
  state.scores = m.scores || {};
  state.endsAt = (m.ends_at || 0) * 1000;
  state.startedAt = state.endsAt - GAME_DURATION_MS;
  state.initialBoard = m.initial_board ? m.initial_board.map((row) => row.slice()) : null;
  state.initialGolden = Array.isArray(m.initial_golden)
    ? m.initial_golden.map(([r, c]) => [r, c])
    : [];

  // Spectators have no inventory / combo of their own.
  state.inventory = [null, null, null];
  $("inventory").hidden = true;
  $("mobileInventory").hidden = true;

  buildLeaderboard();
  if (m.boards) {
    for (const [oid, board] of Object.entries(m.boards)) {
      state.miniRenderers.get(oid)?.setBoard(board);
    }
  }
  if ((state.variant === "items" || state.variant === "team") && m.golden && typeof m.golden === "object") {
    for (const [oid, cells] of Object.entries(m.golden)) {
      const renderer = state.miniRenderers.get(oid);
      if (!renderer) continue;
      renderer.clearGolden();
      for (const [r, c] of cells) renderer.setGolden(r, c, true);
    }
  }
  // Focus the first unit so the big board shows a live game.
  const firstId = leaderboardUnits()[0]?.id;
  if (firstId) setFocusedPlayer(firstId, /*forceCopy*/ true);

  reorderAndRankLeaderboard();

  $("spectateBanner").hidden = false;

  if (m.state === "playing") {
    show("game");
    startTimer();
    startProgress();
    maybeShowStartCountdown();
    // After the countdown step (which would clear the number-hide flag for
    // an already-started round) — keeps an active blind on the focused
    // player visible to the spectator.
    reapplyOpenEffects();
    requestAnimationFrame(() => {
      state.bigRenderer.resize();
      for (const r of state.miniRenderers.values()) r.resize();
    });
  } else if (m.state === "finished") {
    show("game");
    showResult({ scores: m.scores || {}, winner_id: m.winner_id ?? null });
  } else {
    show("game");
  }
}

// ---- Inventory / toast / effects ----
function renderInventory() {
  const visible = state.variant === "items" || state.variant === "team";
  $("inventory").hidden = !visible;
  $("mobileInventory").hidden = !visible;
  const cap = invSize();   // 4 in team mode, else 3
  const remaining = state.endsAt ? state.endsAt - Date.now() : 0;
  const locked = remaining > 0 && remaining <= 10_000;
  for (const btn of document.querySelectorAll(".inv-slot")) {
    const slot = parseInt(btn.dataset.slot, 10);
    // The 4th slot only exists in team mode.
    if (slot >= cap) { btn.hidden = true; btn.classList.remove("has-item", "locked", "item-self", "item-attack", "item-defense"); btn.innerHTML = ""; continue; }
    btn.hidden = false;
    const item = state.inventory[slot];
    btn.classList.remove("item-self", "item-attack", "item-defense");
    if (item && ITEM_META[item]) {
      const meta = ITEM_META[item];
      // Colour-code by role (self / attack / defense) so the type reads
      // at a glance without opening the tooltip.
      btn.classList.add("has-item", `item-${meta.role}`);
      // Icon + ✕ button (corner discard). Re-render rather than mutate so
      // we don't need to track per-slot child nodes across re-renders.
      btn.innerHTML =
        `<span class="inv-icon">${icon(item)}</span>` +
        `<span class="inv-x" role="button" aria-label="버리기" title="버리기 (우클릭/롱프레스)">${icon("discard")}</span>`;
      btn.classList.toggle("locked", meta.attack && locked);
    } else {
      btn.classList.remove("has-item", "locked");
      btn.innerHTML = "";
    }
  }
  // If a slot the user is currently hovering changed contents, hide the
  // stale tooltip — mouseleave doesn't fire when the slot's item is
  // consumed in-place by a click.
  if (typeof hideInvTooltip === "function") hideInvTooltip();
}

// Toasts accept HTML markup (icon + text). Callers must escape any
// user-supplied text (nicknames) via escapeHtml.
let _itemToastTimer = null;
function showItemToast(html) {
  const el = $("itemToast");
  el.innerHTML = html;
  el.hidden = false;
  // Reflow so the opacity transition restarts when called rapidly
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(_itemToastTimer);
  _itemToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 220);
  }, 1800);
}

let _attackToastTimer = null;
function showAttackToast(html) {
  const el = $("attackToast");
  el.innerHTML = html;
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(_attackToastTimer);
  _attackToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2500);
}

function showBoardEffect(kind, durationMs) {
  let el = document.querySelector(`.board-effect-overlay.${kind}`);
  if (!el) {
    el = document.createElement("div");
    el.className = `board-effect-overlay ${kind}`;
    const labels = { shield: "SHIELD", blind: "숫자 숨김", shuffle: "SHUFFLE", overload: "과부하", freeze: "결빙" };
    if (kind === "shield") {
      // Shield is shown purely as a non-occluding inset ring (plus the
      // leaderboard badge). No in-board icon — the old corner crest
      // covered the top-right apple.
      el.innerHTML = "";
    } else {
      el.innerHTML = `${icon(kind)}<span>${labels[kind] || ""}</span>`;
    }
    // Attach to .board-wrap so the overlay hugs the canvas exactly,
    // matching the replay border. board-area would extend past the
    // canvas on mobile and look too far from the apples.
    (document.querySelector(".board-wrap")
      || document.querySelector(".board-area")).appendChild(el);
  }
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("show");
}

function hideBoardEffect(kind) {
  const el = document.querySelector(`.board-effect-overlay.${kind}`);
  if (!el) return;
  el.classList.remove("show");
  setTimeout(() => { el.remove(); }, 220);
}

function showItemUsedToast(by, item, target_id, blocked = false) {
  const meta = ITEM_META[item];
  if (!meta) return;
  const byPlayer = state.room?.players.find((p) => p.id === by);
  const byName = escapeHtml(byPlayer?.nickname ?? "?");
  const shieldTag = `${icon("shield")}`;
  const blockSuffix = blocked ? ` ${shieldTag}<span>방어됨</span>` : "";
  if (by === state.playerId) {
    showItemToast(labelWithIcon(item, `${meta.label} 사용`) + blockSuffix);
  } else if (target_id === state.ownerId && meta.attack) {
    // My (team's) board is the target.
    if (blocked) {
      showItemToast(`${shieldTag}<span>${byName}님의 ${meta.label} 방어!</span>`);
    } else {
      showAttackToast(labelWithIcon(item, `${byName}님이 ${meta.label}!`));
    }
  } else if (meta.attack && target_id) {
    const tName = escapeHtml(ownerName(target_id));
    showItemToast(labelWithIcon(item, `${byName} → ${tName} (${meta.label})`) + blockSuffix);
  } else if (meta.role === "defense" && by !== state.playerId) {
    // Surface opponents' shields too, so attackers see who just walled up.
    showItemToast(labelWithIcon(item, `${byName}님 ${meta.label} 사용`));
  }
}

// Toggle the shield badge on a player's leaderboard row.
function setLeaderboardShield(pid, on) {
  const el = state.lbItems.get(pid)?.shieldEl;
  if (el) el.hidden = !on;
}

function applyEffectStart(target_id, effect, until_ms, hint) {
  const remainingMs = (until_ms ?? Date.now()) - Date.now();
  // Shield shows on the leaderboard for everyone, not just me.
  if (effect === "shield") setLeaderboardShield(target_id, true);
  const mine = target_id === state.ownerId;   // my (team's) board
  if (mine) {
    if (effect === "shield") {
      state.effects.shield = until_ms;
      showBoardEffect("shield", remainingMs);
    } else if (effect === "blind") {
      state.effects.blind = until_ms;
      state.bigRenderer.setBlind(true);
      state.miniRenderers.get(state.ownerId)?.setBlind(true);
      // Hide any sum badge from an in-progress drag started before blind hit.
      sumBadge.hidden = true;
      showBoardEffect("blind", remainingMs);
    } else if (effect === "overload") {
      state.effects.overload = until_ms;
      state.bigRenderer.setOverload(true);
      state.miniRenderers.get(state.ownerId)?.setOverload(true);
      sumBadge.hidden = true;
      showBoardEffect("overload", remainingMs);
    } else if (effect === "freeze") {
      state.effects.freeze = until_ms;
      // Kill any in-progress drag so the lock feels immediate.
      sumBadge.hidden = true;
      state.bigRenderer.setMyDrag(null);
      state.miniRenderers.get(state.ownerId)?.setMyDrag(null);
      showBoardEffect("freeze", remainingMs);
    } else if (effect === "hint" && Array.isArray(hint)) {
      const cells = hint.map((h) => [h.r, h.c]);
      state.bigRenderer.setHint(cells);
      state.miniRenderers.get(state.ownerId)?.setHint(cells);
    }
  } else if (effect === "blind") {
    const mini = state.miniRenderers.get(target_id);
    mini?.setBlind(true);
    if (target_id === state.focusedPlayerId) state.bigRenderer.setBlind(true);
  } else if (effect === "overload") {
    if (target_id === state.focusedPlayerId) state.bigRenderer.setOverload(true);
  }
}

function applyEffectEnd(target_id, effect) {
  if (effect === "shield") setLeaderboardShield(target_id, false);
  const mine = target_id === state.ownerId;
  if (effect === "shield" && mine) {
    state.effects.shield = 0;
    hideBoardEffect("shield");
  } else if (effect === "blind") {
    if (mine) state.effects.blind = 0;
    const mini = state.miniRenderers.get(target_id);
    mini?.setBlind(false);
    if (target_id === state.focusedPlayerId || mine) {
      state.bigRenderer.setBlind(false);
    }
    if (mine) hideBoardEffect("blind");
  } else if (effect === "overload") {
    if (mine) state.effects.overload = 0;
    state.miniRenderers.get(target_id)?.setOverload(false);
    if (target_id === state.focusedPlayerId || mine) {
      state.bigRenderer.setOverload(false);
    }
    if (mine) hideBoardEffect("overload");
  } else if (effect === "freeze") {
    if (mine) {
      state.effects.freeze = 0;
      hideBoardEffect("freeze");
    }
  } else if (effect === "hint") {
    state.bigRenderer.setHint(null);
    state.miniRenderers.get(state.ownerId)?.setHint(null);
  }
}

function applyShuffle(target_id, board, animate) {
  const mini = state.miniRenderers.get(target_id);
  mini?.setBoard(board);
  if (target_id === state.focusedPlayerId) {
    state.bigRenderer.setBoard(board);
    if (animate) state.bigRenderer.shakeOnce?.();
  }
  if (target_id === state.ownerId) {
    state.bigRenderer.shakeOnce?.();
    if (animate) {
      showBoardEffect("shuffle", 600);
      setTimeout(() => hideBoardEffect("shuffle"), 600);
    }
  }
  if (target_id === state.focusedPlayerId) updateNoMoves();
}

function clearAllEffectVisuals() {
  state.bigRenderer.setBlind(false);
  state.bigRenderer.setOverload(false);
  state.bigRenderer.setHint(null);
  state.bigRenderer.clearGolden();
  for (const r of state.miniRenderers.values()) {
    r.setBlind(false);
    r.setOverload(false);
    r.setHint(null);
    r.clearGolden();
  }
  hideBoardEffect("shield");
  hideBoardEffect("blind");
  hideBoardEffect("shuffle");
  hideBoardEffect("overload");
  hideBoardEffect("freeze");
  for (const pid of state.lbItems.keys()) setLeaderboardShield(pid, false);
  setCombo(0);
}

function setCombo(n, triggered = false) {
  state.combo = n;
  const badge = $("comboBadge");
  const mob = $("mobileCombo");
  const iconEl = badge.querySelector(".combo-icon");
  const text = badge.querySelector(".combo-text");
  const badgeTrigger = badge.querySelector(".combo-trigger-msg");
  const mobDefault = mob.querySelector(".mobile-combo-default");
  const mobTrigger = mob.querySelector(".mobile-combo-trigger");
  clearTimeout(state._comboMessageTimer);

  if (triggered) {
    // In-place swap: hide the normal icon+text, show the trigger pill.
    iconEl.hidden = true;
    text.hidden = true;
    badgeTrigger.hidden = false;
    mobDefault.hidden = true;
    mobTrigger.hidden = false;
    badge.classList.add("triggered");
    badge.hidden = false;
    mob.hidden = false;
    badge.classList.remove("pulse");
    void badge.offsetWidth;
    badge.classList.add("pulse");
    state._comboMessageTimer = setTimeout(() => {
      badge.classList.remove("triggered");
      badgeTrigger.hidden = true;
      iconEl.hidden = false;
      text.hidden = false;
      mobTrigger.hidden = true;
      mobDefault.hidden = false;
      // Combo is 0 post-trigger; hide until next chain.
      badge.hidden = true;
      mob.hidden = true;
    }, 2000);
    return;
  }

  // Normal path. n == 0 only happens right after a trigger reset → hide.
  // Any active chain (1+) is shown; combo breaks land at 1 too, so the
  // badge briefly flashes a fresh "콤보 1" instead of staying blank.
  badge.classList.remove("triggered");
  badgeTrigger.hidden = true;
  iconEl.hidden = false;
  text.hidden = false;
  mobTrigger.hidden = true;
  mobDefault.hidden = false;
  if (n > 0) {
    $("comboCount").textContent = String(n);
    $("mobileComboCount").textContent = String(n);
    badge.hidden = false;
    mob.hidden = false;
    badge.classList.remove("pulse");
    void badge.offsetWidth;
    badge.classList.add("pulse");
  } else {
    badge.hidden = true;
    mob.hidden = true;
  }
}

function applyInitialGoldenToAll() {
  if (!Array.isArray(state.initialGolden) || state.initialGolden.length === 0) return;
  for (const [r, c] of state.initialGolden) {
    state.bigRenderer.setGolden(r, c, true);
    for (const renderer of state.miniRenderers.values()) {
      renderer.setGolden(r, c, true);
    }
  }
}

// True if `board` has at least one axis-aligned rectangle summing to 10.
// Row-pair column sums + a two-pointer window — O(rows² · cols), trivial
// for the 10×17 board. Values are non-negative so the sliding window is valid.
function boardHasMove(board) {
  if (!board || !board.length) return true;  // unknown → don't flash the badge
  const R = board.length;
  const C = board[0].length;
  for (let r1 = 0; r1 < R; r1++) {
    const colSum = new Array(C).fill(0);
    for (let r2 = r1; r2 < R; r2++) {
      const row = board[r2];
      let lo = 0;
      let sum = 0;
      for (let hi = 0; hi < C; hi++) {
        colSum[hi] += row[hi] || 0;
        sum += colSum[hi];
        while (sum > 10 && lo <= hi) { sum -= colSum[lo]; lo++; }
        if (sum === 10) return true;
      }
    }
  }
  return false;
}

// Show / hide the "no clearable apples" badge for the board currently on
// the big canvas. Only while a live round is actually in progress.
function updateNoMoves() {
  const badge = $("noMovesBadge");
  if (!badge) return;
  const live =
    !screens.game.hidden &&
    !state.replayActive &&
    !isRoundOver() &&
    !(state.startedAt && Date.now() < state.startedAt);
  badge.hidden = !live || boardHasMove(state.bigRenderer?.board);
}

// ---- Game lifecycle ----
function onGameStart(m) {
  // A fresh round means we're a full player (covers promoted spectators).
  state.isSpectator = false;
  $("spectateBanner").hidden = true;
  $("noMovesBadge").hidden = true;
  state.endsAt = m.ends_at * 1000;
  state.startedAt = state.endsAt - GAME_DURATION_MS;
  state.events = [];
  state.variant = m.variant || state.variant || "classic";
  // Team structure + my board owner (team id, or my player id otherwise).
  state.teams = Array.isArray(m.teams) ? m.teams : null;
  state.ownerId = ownerOf(state.playerId);
  state.inventory = invSlots();
  state.effects = { shield: 0, blind: 0, hint: 0, overload: 0, freeze: 0 };
  renderInventory();
  // Match countdown done — clear it
  state.matchDeadlineMs = null;
  if (state.matchTickerId) {
    clearInterval(state.matchTickerId);
    state.matchTickerId = null;
  }
  state.initialBoard = m.board.map((row) => row.slice());
  state.initialGolden = Array.isArray(m.golden)
    ? m.golden.map(([r, c]) => [r, c])
    : [];
  state.scores = {};
  for (const u of leaderboardUnits()) state.scores[u.id] = 0;
  state.gameWinnerId = null;
  // Hide result banner if it was visible from a prior round
  $("resultBanner").hidden = true;
  $("mobileResultActions").hidden = true;
  // Replay controls only shown after game ends, not during live play
  $("replayControls").hidden = true;
  $("topProgress").hidden = false;

  state.bigRenderer.setBoard(m.board);
  state.bigRenderer.setMyDrag(null);
  state.bigRenderer.setBlind(false);
  state.bigRenderer.setHint(null);
  state.bigRenderer.clearGolden();
  setCombo(0);

  buildLeaderboard();
  // Stamp the shared golden positions onto every renderer once minis exist
  if (state.variant === "items" || state.variant === "team") applyInitialGoldenToAll();
  // Default focus = my (team's) board
  setFocusedPlayer(state.ownerId, /*forceCopy*/ false);
  reorderAndRankLeaderboard();

  show("game");
  screens.game.classList.remove("drawer-open");
  startTimer();
  startProgress();
  maybeShowStartCountdown();
  scheduleBgmAtRoundStart();
  requestAnimationFrame(() => {
    state.bigRenderer.resize();
    for (const r of state.miniRenderers.values()) r.resize();
  });
}

function scheduleBgmAtRoundStart() {
  if (state._bgmStartTimer) clearTimeout(state._bgmStartTimer);
  const delay = Math.max(0, (state.startedAt ?? 0) - Date.now());
  state._bgmStartTimer = setTimeout(() => {
    state._bgmStartTimer = null;
    audio.startBgm();
  }, delay);
}

function setNumbersBlinded(on) {
  // Hide apple numbers on every visible renderer. Reuses the blind flag,
  // which is safe during countdown because USE_ITEM is gated server-side
  // so no item-driven blind effect can race with this.
  state.bigRenderer?.setBlind(on);
  for (const r of state.miniRenderers.values()) r.setBlind(on);
}

function maybeShowStartCountdown() {
  const el = $("startCountdown");
  const numEl = $("startCountdownNum");
  if (!el || !numEl) return;
  const startsAt = state.startedAt;
  if (!startsAt || Date.now() >= startsAt) {
    el.hidden = true;
    setNumbersBlinded(false);
    return;
  }
  el.hidden = false;
  el.classList.remove("go");
  numEl.classList.remove("pulse");
  setNumbersBlinded(true);
  let last = null;
  let goScheduled = false;
  const tick = () => {
    if (!state.startedAt || state.startedAt !== startsAt) {
      el.hidden = true;
      setNumbersBlinded(false);
      return;
    }
    const remaining = startsAt - Date.now();
    if (remaining <= 0) {
      if (goScheduled) return;
      goScheduled = true;
      numEl.textContent = "GO!";
      numEl.classList.remove("pulse");
      void numEl.offsetWidth;
      numEl.classList.add("pulse");
      el.classList.add("go");
      audio.countdownBeep(0);
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove("go");
        numEl.classList.remove("pulse");
        // Reveal numbers exactly when GO disappears.
        setNumbersBlinded(false);
      }, 500);
      return;
    }
    const sec = Math.ceil(remaining / 1000);
    if (sec !== last) {
      last = sec;
      numEl.textContent = String(sec);
      audio.countdownBeep(sec);
      // Restart pulse animation on each tick
      numEl.classList.remove("pulse");
      void numEl.offsetWidth;
      numEl.classList.add("pulse");
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function onRoomUpdate(room) {
  state.room = { ...room, players: [...room.players] };
  state.hostId = room.host_id;
  state.mode = room.mode;
  state.variant = room.variant || "classic";
  // Teams come on the snapshot during a live team round (empty in the lobby).
  state.teams = (Array.isArray(room.teams) && room.teams.length) ? room.teams : null;
  state.ownerId = ownerOf(state.playerId);
  $("roomCode").textContent = room.id;
  $("roomCodeSection").hidden = (room.mode === "solo" || room.mode === "random");
  renderLobby();
}

const MEDAL_ICONS = { gold: "🥇", silver: "🥈", bronze: "🥉" };

function appendMedalBadges(parentSpan, medals) {
  if (!medals) return;
  for (const kind of ["gold", "silver", "bronze"]) {
    const n = medals[kind] | 0;
    if (n <= 0) continue;
    const badge = document.createElement("span");
    badge.className = `medal medal-${kind}`;
    badge.textContent = `${MEDAL_ICONS[kind]}x${n}`;
    parentSpan.appendChild(badge);
  }
}

function renderLobby() {
  if (!state.room) return;
  const list = $("playerList");
  list.innerHTML = "";
  const canRenameMe = state.mode !== "random";  // random matches stay anonymous
  const iAmHost = state.playerId === state.hostId;
  for (const p of state.room.players) {
    const li = document.createElement("li");
    if (p.id === state.hostId) li.classList.add("host");
    const isMe = p.id === state.playerId;
    const nameSpan = document.createElement("span");
    nameSpan.className = "lobby-name";
    nameSpan.textContent = p.nickname + (isMe ? " (나)" : "");
    li.appendChild(nameSpan);

    const medalsSpan = document.createElement("span");
    medalsSpan.className = "lobby-medals";
    appendMedalBadges(medalsSpan, p.medals);
    if (medalsSpan.childNodes.length > 0) li.appendChild(medalsSpan);

    const actions = document.createElement("span");
    actions.className = "lobby-row-actions";
    if (isMe && canRenameMe) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "nick-edit-btn";
      editBtn.setAttribute("aria-label", "닉네임 변경");
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => beginNicknameEdit(li, nameSpan));
      actions.appendChild(editBtn);
    } else if (iAmHost && state.mode === "friend" && !isMe) {
      // Host can rename + kick other players (lobby only).
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "nick-edit-btn";
      editBtn.setAttribute("aria-label", `${p.nickname} 닉네임 변경`);
      editBtn.title = "닉네임 변경";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => beginHostNicknameEdit(li, nameSpan, p.id));
      actions.appendChild(editBtn);

      const kickBtn = document.createElement("button");
      kickBtn.type = "button";
      kickBtn.className = "lobby-kick-btn";
      kickBtn.setAttribute("aria-label", `${p.nickname} 내보내기`);
      kickBtn.title = "내보내기";
      kickBtn.innerHTML = icon("ban");
      kickBtn.addEventListener("click", () => {
        if (confirm(`'${p.nickname}'님을 방에서 내보낼까요?`)) {
          state.ws?.send("kick", { player_id: p.id });
        }
      });
      actions.appendChild(kickBtn);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
  const cnt = state.room.players.length;
  const cap = state.room.capacity ?? 2;
  $("playerCount").textContent = `${cnt} / ${cap}`;
  const isHost = iAmHost;
  const minToStart = state.variant === "team" ? 4 : 2;  // teams need 2 pairs
  const canStart = state.mode === "friend" && isHost && cnt >= minToStart;
  $("startBtn").hidden = !canStart;

  // Capacity section: visible only in friend mode
  const showCap = state.mode === "friend";
  $("capacitySection").hidden = !showCap;
  if (showCap) {
    capacityInput.disabled = !isHost;
    capacityInput.min = String(Math.max(2, cnt));
    if (document.activeElement !== capacityInput) {
      capacityInput.value = String(cap);
    }
    $("capacityHelper").textContent = isHost
      ? `2~50명 사이로 직접 입력 (현재 인원 ${cnt}명 미만으로는 줄일 수 없음)`
      : `호스트가 설정합니다 (현재 ${cap}명)`;
  }

  // Variant section: visible only in friend mode
  const showVariant = state.mode === "friend";
  $("variantSection").hidden = !showVariant;
  if (showVariant) {
    document.querySelectorAll(".variant-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.variant === state.variant);
      b.disabled = !isHost;
    });
    const variantKo = { classic: "클래식", items: "아이템전", team: "팀전" };
    if (isHost && state.variant === "team") {
      $("variantHelper").innerHTML =
        "<strong>팀전</strong> — 최소 4명. 2명씩 한 팀이 되어 같은 보드를 함께 풀어요. " +
        "인벤토리는 팀이 공유(4칸), 홀수면 한 명은 🤖 AI 봇과 한 팀이 됩니다.";
    } else if (isHost && state.variant === "items") {
      const chips = ITEM_ORDER
        .map((k) => `<span class="ico">${icon(k)}</span>`)
        .join(" ");
      $("variantHelper").innerHTML =
        `황금 사과를 합10에 포함시키면 랜덤 아이템 (${chips}) 획득`;
    } else {
      $("variantHelper").textContent = isHost
        ? "원하면 아이템전 / 팀전으로 바꿔보세요"
        : `호스트가 모드를 정합니다 (현재 ${variantKo[state.variant] || "클래식"})`;
    }
  }

  // Nickname editing in the player list is gated on state.mode in
  // renderLobby's player loop — nothing extra to do here for random.

  if (state.mode === "friend") {
    if (cnt < minToStart) {
      $("lobbyMsg").textContent = state.variant === "team"
        ? `팀전은 최소 4명이 필요해요. 친구에게 코드/링크를 공유하세요. (${cnt}/4)`
        : "친구에게 코드 또는 초대 링크를 공유하세요.";
    } else if (isHost) {
      $("lobbyMsg").textContent = cnt < cap
        ? "지금 시작하거나 더 기다릴 수 있어요."
        : "방이 가득 찼습니다. 시작 버튼을 누르세요.";
    } else {
      $("lobbyMsg").textContent = "방장이 시작하기를 기다리는 중…";
    }
  } else if (state.mode === "random") {
    const minMatch = state.variant === "team" ? 4 : 2;
    if (cnt < minMatch) {
      $("lobbyMsg").textContent = `상대를 기다리는 중... (${cnt}/${minMatch})`;
    } else if (state.matchDeadlineMs) {
      const remaining = Math.max(0, state.matchDeadlineMs - Date.now());
      const sec = Math.ceil(remaining / 1000);
      $("lobbyMsg").textContent = `${cnt}명 매칭됨 — ${sec}초 후 시작`;
    } else {
      $("lobbyMsg").textContent = `${cnt}명 매칭됨`;
    }
  }
}

function startMatchCountdownTicker() {
  if (state.matchTickerId) clearInterval(state.matchTickerId);
  state.matchTickerId = setInterval(() => {
    if (!state.matchDeadlineMs) {
      clearInterval(state.matchTickerId);
      state.matchTickerId = null;
      return;
    }
    if (Date.now() >= state.matchDeadlineMs + 200) {
      // Timer should have fired; stop ticking (server will push game_start)
      clearInterval(state.matchTickerId);
      state.matchTickerId = null;
      return;
    }
    if (!screens.lobby.hidden) renderLobby();
  }, 250);
}

// ---- Leaderboard ----
function buildLeaderboard() {
  const ul = $("lbList");
  ul.innerHTML = "";
  // Tear down the previous round's renderers before dropping references —
  // each one holds a window.resize listener + ResizeObserver that would
  // otherwise stay alive on detached canvases.
  for (const r of state.miniRenderers.values()) r.dispose?.();
  state.miniRenderers.clear();
  state.lbItems.clear();
  // One row per "unit": a team in team mode, otherwise a player. The unit
  // id is the board owner id everything else keys on.
  const units = leaderboardUnits();
  for (const u of units) {
    const li = document.createElement("li");
    li.className = "lb-item";
    if (u.isMe) li.classList.add("me");
    li.dataset.ownerId = u.id;

    const rankEl = document.createElement("span");
    rankEl.className = "lb-rank";
    rankEl.textContent = "#-";
    const nameEl = document.createElement("span");
    nameEl.className = "lb-name";
    nameEl.textContent = u.name + (u.isMe ? " (me)" : "");
    // Shield indicator — shown while this unit has an active shield.
    const shieldEl = document.createElement("span");
    shieldEl.className = "lb-shield";
    shieldEl.title = "방어 중";
    shieldEl.innerHTML = icon("shield");
    shieldEl.hidden = true;
    const scoreEl = document.createElement("span");
    scoreEl.className = "lb-score";
    scoreEl.textContent = "0";

    const row = document.createElement("div");
    row.className = "lb-row";
    row.append(rankEl, nameEl, shieldEl, scoreEl);

    const c = document.createElement("canvas");
    c.className = "lb-mini";
    li.append(row, c);
    ul.appendChild(li);

    li.addEventListener("click", () => setFocusedPlayer(u.id));

    const renderer = new BoardRenderer(c, { mini: true });
    if (state.initialBoard) renderer.setBoard(state.initialBoard);
    state.miniRenderers.set(u.id, renderer);
    state.lbItems.set(u.id, { li, rankEl, nameEl, scoreEl, shieldEl });
  }
  $("lbCount").textContent = String(units.length);
  $("totalPlayers").textContent = String(units.length);
}

function setFocusedPlayer(pid, forceCopy = true) {
  if (!pid || !state.miniRenderers.has(pid)) return;
  const changed = state.focusedPlayerId !== pid;
  state.focusedPlayerId = pid;
  for (const [id, item] of state.lbItems.entries()) {
    item.li.classList.toggle("focused", id === pid);
  }
  // Mirror that player's mini board state onto the big renderer
  if (changed || forceCopy) {
    const mini = state.miniRenderers.get(pid);
    if (mini && mini.board) {
      state.bigRenderer.setBoard(mini.board);
      state.bigRenderer.setMyDrag(null);
      // Carry over the focused player's surviving golden cells so the
      // big board shows the same gold markers as their mini.
      state.bigRenderer.clearGolden();
      for (const key of mini.goldenCells) {
        const [r, c] = key.split(",").map(Number);
        state.bigRenderer.setGolden(r, c, true);
      }
    }
  }
  // Label only when looking at another unit's board (not my own).
  const label = $("focusLabel");
  if (pid === state.ownerId) {
    label.hidden = true;
    label.classList.remove("viewing");
  } else {
    label.textContent = `${ownerName(pid)}의 보드`;
    label.hidden = false;
    label.classList.add("viewing");
  }
  // Close mobile drawer after picking
  screens.game.classList.remove("drawer-open");
  updateNoMoves();
}

function reorderAndRankLeaderboard(scoresOverride = null) {
  const scores = scoresOverride || state.scores;
  // Rank by unit (team or player); scores are keyed by owner id.
  const units = leaderboardUnits();
  const ranked = units.slice().sort((a, b) => {
    const da = scores[a.id] || 0;
    const db = scores[b.id] || 0;
    if (db !== da) return db - da;
    return a.name.localeCompare(b.name);
  });
  ranked.forEach((u, idx) => {
    const item = state.lbItems.get(u.id);
    if (!item) return;
    item.li.style.order = String(idx);
    item.rankEl.textContent = `#${idx + 1}`;
    item.scoreEl.textContent = String(scores[u.id] || 0);
    if (u.id === state.ownerId) {
      $("myRank").textContent = `#${idx + 1}`;
      $("myScoreNum").textContent = String(scores[u.id] || 0);
      $("miniScore").textContent = String(scores[u.id] || 0);
      state.myScore = scores[u.id] || 0;
    }
  });
}

// ---- Timer / Progress ----
function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  let prevLocked = null;
  const tick = () => {
    // Clamp to GAME_DURATION so countdown phase displays "2:00" instead of "2:03".
    const raw = Math.max(0, state.endsAt - Date.now());
    const remaining = Math.min(raw, GAME_DURATION_MS);
    const sec = Math.ceil(remaining / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const text = `${m}:${String(s).padStart(2, "0")}`;
    const el = $("timer");
    el.textContent = text;
    el.classList.toggle("warn", sec <= 30 && sec > 10);
    el.classList.toggle("danger", sec <= 10);
    $("miniTimer").textContent = text;
    // Refresh inventory lock state when we cross the 10s threshold
    if (state.variant === "items" || state.variant === "team") {
      const locked = remaining > 0 && remaining <= 10_000;
      if (locked !== prevLocked) {
        prevLocked = locked;
        renderInventory();
      }
    }
    if (remaining <= 0 && state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  };
  tick();
  state.timerInterval = setInterval(tick, 200);
}

function startProgress() {
  if (state.progressInterval) clearInterval(state.progressInterval);
  const startTs = state.startedAt;
  const fill = $("progressFill");
  const vfill = $("verticalProgressFill");
  fill.classList.remove("warn", "danger");
  vfill.classList.remove("warn", "danger");
  const tick = () => {
    // Clamp at zero during the pre-game countdown so the bar doesn't go negative.
    const elapsed = Math.max(0, Date.now() - startTs);
    const pct = Math.min(100, (elapsed / GAME_DURATION_MS) * 100);
    fill.style.width = pct + "%";
    vfill.style.width = pct + "%";
    const remaining = GAME_DURATION_MS - elapsed;
    const warn = remaining <= 30000 && remaining > 10000;
    const danger = remaining <= 10000;
    fill.classList.toggle("warn", warn);
    fill.classList.toggle("danger", danger);
    vfill.classList.toggle("warn", warn);
    vfill.classList.toggle("danger", danger);
    if (elapsed >= GAME_DURATION_MS) {
      clearInterval(state.progressInterval);
      state.progressInterval = null;
    }
  };
  tick();
  state.progressInterval = setInterval(tick, 100);
}

// ---- Result mode (banner overlay + auto replay) ----
function showResult(detail) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.timerInterval = null;
  state.progressInterval = null;

  const { scores, winner_id } = detail;
  state.scores = scores || {};
  state.gameWinnerId = winner_id ?? null;
  reorderAndRankLeaderboard();

  let title = "";
  let subtitle = "";
  const replaySub = "🔁 리플레이 자동 재생 중 — 막대를 드래그해 구간 이동";
  if (state.isSpectator) {
    title = "경기 종료";
    subtitle = replaySub;
  } else if (state.mode === "solo") {
    title = `점수 ${scores[state.playerId] ?? 0} / 170`;
    subtitle = replaySub;
  } else if (winner_id === null || winner_id === undefined) {
    title = "무승부 🤝";
    subtitle = replaySub;
  } else if (winner_id === state.ownerId) {
    // winner_id is a team id in team mode, else a player id — ownerId matches both.
    title = state.variant === "team" ? "우리 팀 승리! 🎉" : "승리! 🎉";
    subtitle = replaySub;
  } else {
    title = "패배 😢";
    subtitle = replaySub;
  }
  $("resultTitle").textContent = title;
  $("resultSubtitle").textContent = subtitle;

  // Show result banner + rematch/home buttons.
  // friend 모드는 rematch가 곧 "대기실로 이동"이라 라벨을 그렇게 바꿔야
  // 사용자가 누르자마자 새 게임이 시작될 거란 오해를 안 함. 호스트는
  // 대기실에서 시작 버튼을 한 번 더 눌러야 게임이 시작됨.
  const players = state.room?.players ?? [];
  const enough = players.length >= 2;
  const canRematch =
    state.mode === "solo" ? true
    : state.mode === "random" ? true   // every random player can re-queue alone
    : state.playerId === state.hostId && enough;  // friend: host gated
  const rematchBtn = $("rematchBtn");
  const rematchLabel =
    state.mode === "friend" ? "대기실로"
    : state.mode === "random" ? "다시하기"
    : "새 게임";
  rematchBtn.textContent = rematchLabel;
  rematchBtn.hidden = !canRematch;
  // Mirror to the mobile-overlay rematch button — desktop result-banner
  // is display:none on the rotated phone view so without this mobile
  // players had no rematch entry point.
  $("mobileRematchBtn").textContent = rematchLabel;
  $("mobileResultActions").hidden = !canRematch;
  $("resultBanner").hidden = false;

  // Stay on game screen and auto-start replay if there's anything to play
  show("game");
  if (state.events.length > 0 && state.initialBoard) {
    startReplay();
  }
}

// ---- Replay (video-player style with seekable scrubber and speed control) ----
const REPLAY_SPEEDS = [1, 2, 4, 16];
const REPLAY_DEFAULT_SPEED = 4;

function startReplay() {
  if (state.replayActive || !state.initialBoard) return;
  // Stop any live game timers/progress
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.timerInterval = null;
  state.progressInterval = null;

  state.replayActive = true;
  state.replaySpeed = REPLAY_DEFAULT_SPEED;
  state.replayPaused = false;
  state.replayTime = 0;
  state.replayCumScores = {};
  for (const u of leaderboardUnits()) state.replayCumScores[u.id] = 0;

  // Reset boards to initial state
  state.bigRenderer.setBoard(state.initialBoard);
  state.bigRenderer.setMyDrag(null);
  for (const r of state.miniRenderers.values()) {
    r.setBoard(state.initialBoard);
    r.setMyDrag(null);
  }
  // Item-mode visuals must start from a clean slate so events between
  // 0 and the seek point re-apply them deterministically.
  clearAllEffectVisuals();
  // Goldens were set at game start, not as events, so re-stamp them
  // so the replay starts from the true initial visual state.
  if (state.variant === "items" || state.variant === "team") applyInitialGoldenToAll();
  state.scores = { ...state.replayCumScores };
  reorderAndRankLeaderboard();

  // Show controls; hide the top progress bar so it doesn't duplicate
  // the scrubber. We're already on the game screen.
  $("replayControls").hidden = false;
  $("topProgress").hidden = true;
  $("noMovesBadge").hidden = true;
  $("replayBadge").hidden = false;
  $("replayBadgeMobile").hidden = false;
  document.body.classList.add("on-replay");
  show("game");
  requestAnimationFrame(() => {
    state.bigRenderer.resize();
    for (const r of state.miniRenderers.values()) r.resize();
  });

  updateReplaySpeedButtons();
  updateReplayPlayPause();
  updateReplayProgress();

  // Start RAF loop
  state.replayLastTick = performance.now();
  state.replayRafId = requestAnimationFrame(replayTick);
}

function exitReplay() {
  if (!state.replayActive) return;
  state.replayActive = false;
  if (state.replayRafId) cancelAnimationFrame(state.replayRafId);
  state.replayRafId = null;
  $("replayControls").hidden = true;
  $("topProgress").hidden = false;
  $("replayBadge").hidden = true;
  $("replayBadgeMobile").hidden = true;
  document.body.classList.remove("on-replay");
}

function replayTick(now) {
  if (!state.replayActive) {
    state.replayRafId = null;
    return;
  }
  const dt = now - state.replayLastTick;
  state.replayLastTick = now;
  if (!state.replayPaused) {
    const newTime = Math.min(GAME_DURATION_MS, state.replayTime + dt * state.replaySpeed);
    if (newTime > state.replayTime) {
      applyReplayEventsBetween(state.replayTime, newTime, /*animate*/ true);
      state.replayTime = newTime;
      reorderAndRankLeaderboard();
      updateReplayProgress();
    }
    if (newTime >= GAME_DURATION_MS) {
      state.replayPaused = true;
      updateReplayPlayPause();
    }
  }
  state.replayRafId = requestAnimationFrame(replayTick);
}

function applyReplayEventsBetween(fromMs, toMs, animate) {
  // Events are appended in chronological order during the live game, so we
  // just iterate; if perf becomes a concern we can switch to a binary search.
  for (const ev of state.events) {
    if (ev.t_ms <= fromMs || ev.t_ms > toMs) continue;
    const kind = ev.kind || "clear";  // legacy events lacked kind
    if (kind === "clear") {
      const mini = state.miniRenderers.get(ev.player_id);
      const isFocused = ev.player_id === state.focusedPlayerId;
      if (animate) {
        mini?.clearCells(ev.cells);
        if (isFocused) state.bigRenderer.clearCells(ev.cells);
      } else {
        mini?.applyClear(ev.cells);
        if (isFocused) state.bigRenderer.applyClear(ev.cells);
      }
      // Replay scoring uses raw cell count — the bonus +1 is a live-only
      // perk that's hard to reconstruct accurately, and showing the raw
      // count keeps the replay's leaderboard easy to read.
      state.replayCumScores[ev.player_id] =
        (state.replayCumScores[ev.player_id] || 0) + ev.cells.length;
    } else if (kind === "shuffle") {
      applyShuffle(ev.target_id, ev.board, animate);
    } else if (kind === "effect_start") {
      applyEffectStart(ev.target_id, ev.effect, ev.until_ms, ev.hint);
    } else if (kind === "effect_end") {
      applyEffectEnd(ev.target_id, ev.effect);
    } else if (kind === "item_used") {
      if (animate) showItemUsedToast(ev.by, ev.item, ev.target_id, !!ev.blocked);
    }
  }
  state.scores = { ...state.replayCumScores };
}

function replaySeekTo(targetMs) {
  targetMs = Math.max(0, Math.min(GAME_DURATION_MS, targetMs));
  if (targetMs >= state.replayTime) {
    applyReplayEventsBetween(state.replayTime, targetMs, /*animate*/ false);
  } else {
    // Backward: rebuild from initial. Wipe effect overlays so events
    // 0..target re-apply them; otherwise stale state lingers.
    state.bigRenderer.setBoard(state.initialBoard);
    for (const r of state.miniRenderers.values()) r.setBoard(state.initialBoard);
    clearAllEffectVisuals();
    if (state.variant === "items" || state.variant === "team") applyInitialGoldenToAll();
    state.replayCumScores = {};
    for (const u of leaderboardUnits()) state.replayCumScores[u.id] = 0;
    state.scores = { ...state.replayCumScores };
    applyReplayEventsBetween(0, targetMs, /*animate*/ false);
  }
  state.replayTime = targetMs;
  reorderAndRankLeaderboard();
  updateReplayProgress();
}

function updateReplayProgress() {
  const pct = (state.replayTime / GAME_DURATION_MS) * 100;
  $("replayScrubFill").style.width = pct + "%";
  $("replayScrubThumb").style.left = pct + "%";
  $("progressFill").style.width = pct + "%";
  $("verticalProgressFill").style.width = pct + "%";
  $("replayCurrent").textContent = formatMmSs(state.replayTime);
  // Top-bar timer counts down so it matches the live game look
  const remaining = Math.max(0, GAME_DURATION_MS - state.replayTime);
  const text = formatMmSs(remaining);
  const timerEl = $("timer");
  timerEl.textContent = text;
  $("miniTimer").textContent = text;
  const remSec = Math.ceil(remaining / 1000);
  const warn = remSec <= 30 && remSec > 10;
  const danger = remSec <= 10;
  timerEl.classList.toggle("warn", warn);
  timerEl.classList.toggle("danger", danger);
  const fill = $("progressFill");
  fill.classList.toggle("warn", warn);
  fill.classList.toggle("danger", danger);
  const vfill = $("verticalProgressFill");
  vfill.classList.toggle("warn", warn);
  vfill.classList.toggle("danger", danger);
}

function updateReplaySpeedButtons() {
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    const sp = parseInt(btn.dataset.speed, 10);
    btn.classList.toggle("active", sp === state.replaySpeed);
  });
}

function updateReplayPlayPause() {
  setIcon($("replayPlayPause"), state.replayPaused ? "play" : "pause");
}

function formatMmSs(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Speed buttons
document.querySelectorAll(".speed-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.replaySpeed = parseInt(btn.dataset.speed, 10) || REPLAY_DEFAULT_SPEED;
    updateReplaySpeedButtons();
  });
});

// Play / pause
$("replayPlayPause").addEventListener("click", () => {
  if (state.replayTime >= GAME_DURATION_MS) {
    replaySeekTo(0);
    state.replayPaused = false;
  } else {
    state.replayPaused = !state.replayPaused;
  }
  updateReplayPlayPause();
});

// The replay '닫기' (close) button was removed — closing the replay left
// the board/leaderboard frozen on a mid-replay frame, which read as a bug.
// The replay now simply plays to the end and pauses; 새 게임 / 홈으로 in the
// result banner are the way out (both call exitReplay internally).

// Scrubber drag/click
(function bindScrubber() {
  const el = $("replayScrub");
  let scrubbing = false;
  let resumeAfter = false;

  function timeAt(clientX) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return (x / Math.max(1, r.width)) * GAME_DURATION_MS;
  }

  el.addEventListener("pointerdown", (e) => {
    if (!state.replayActive) return;
    scrubbing = true;
    resumeAfter = !state.replayPaused;
    state.replayPaused = true;
    updateReplayPlayPause();
    try { el.setPointerCapture(e.pointerId); } catch {}
    replaySeekTo(timeAt(e.clientX));
  });
  el.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    replaySeekTo(timeAt(e.clientX));
  });
  function endScrub(e) {
    if (!scrubbing) return;
    scrubbing = false;
    try { if (e) el.releasePointerCapture(e.pointerId); } catch {}
    if (resumeAfter && state.replayTime < GAME_DURATION_MS) {
      state.replayPaused = false;
      state.replayLastTick = performance.now();
    }
    updateReplayPlayPause();
  }
  el.addEventListener("pointerup", endScrub);
  el.addEventListener("pointercancel", endScrub);
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
