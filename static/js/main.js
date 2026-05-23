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
};

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
  top:    { hint: 2, shuffle: 4, blind: 2, overload: 2, freeze: 1, shield: 9 },
  middle: { hint: 2, shuffle: 3, blind: 5, overload: 5, freeze: 3, shield: 2 },
  bottom: { hint: 6, shuffle: 5, blind: 3, overload: 2, freeze: 2, shield: 2 },
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
    if (state.focusedPlayerId !== state.playerId) return; // viewing only
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
    // Mirror onto my own mini so the leaderboard shows my live drag
    state.miniRenderers.get(state.playerId)?.setMyDrag(rect);
  },
  onSubmit: (rect) => {
    sumBadge.hidden = true;
    if (state.replayActive) return;
    if (isRoundOver() || isFrozen()) return;
    if (state.focusedPlayerId !== state.playerId) return;
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
    state.miniRenderers.get(state.playerId)?.clearCells(arr);
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
    const variant = btn.dataset.matchVariant === "items" ? "items" : "classic";
    await startSession("match", null, variant);
  });
});
$("matchVariantBackBtn")?.addEventListener("click", () => show("home"));

// ---- Help screen ----
$("helpOpenBtn")?.addEventListener("click", () => { renderHelpItems(); show("helpScreen"); });
$("helpBackBtn")?.addEventListener("click", () => show("home"));

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
    if (btn.classList.contains("locked")) {
      showItemToast("<span>⏳ 마지막 10초엔 공격 아이템을 쓸 수 없어요</span>");
      return;
    }
    hideInvTooltip();  // slot will be consumed; clear lingering tooltip
    state.ws?.send("use_item", { slot });
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
    const variant = state.variant === "items" ? "items" : "classic";
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
  state.inventory = [null, null, null];
  state.effects = { shield: 0, blind: 0, hint: 0, overload: 0, freeze: 0 };
  state.initialGolden = [];
  $("inventory").hidden = true;
  $("mobileInventory").hidden = true;
  $("invTooltip").hidden = true;
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
    // Server clears the slot — mirror that locally so the inventory UI
    // empties immediately for the player who triggered the use.
    if (by === state.playerId && typeof slot === "number") {
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

  ws.addEventListener("msg:room_reset", (e) => {
    // Friend room came back to the lobby for the next round
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
    const { player_id, r1, c1, r2, c2 } = e.detail;
    if (player_id === state.playerId) return;
    const rect = { r1, c1, r2, c2 };
    state.miniRenderers.get(player_id)?.setMyDrag(rect);
    if (player_id === state.focusedPlayerId) {
      state.bigRenderer.setMyDrag(rect);
    }
    // Self-heal: if a peer submits something invalid (server rejects)
    // and never drags again, the last rect would hang on their mini
    // forever — the server doesn't broadcast peer rejects. Auto-clear
    // after a few seconds with no update; the next drag_update will
    // reset the timer.
    if (!state._peerDragTimers) state._peerDragTimers = new Map();
    const prev = state._peerDragTimers.get(player_id);
    if (prev) clearTimeout(prev);
    state._peerDragTimers.set(player_id, setTimeout(() => {
      state.miniRenderers.get(player_id)?.setMyDrag(null);
      if (player_id === state.focusedPlayerId) state.bigRenderer.setMyDrag(null);
      state._peerDragTimers?.delete(player_id);
    }, 2500));
  });

  ws.addEventListener("msg:clear", (e) => {
    const { cells, scores, player_id, t_ms, combo, combo_triggered } = e.detail;
    state.events.push({ kind: "clear", t_ms: t_ms ?? 0, player_id, cells });
    if (player_id === state.playerId && state.variant === "items") {
      setCombo(combo ?? 0, !!combo_triggered);
    }
    if (player_id === state.playerId) {
      // Server confirmation of my own submit. Pop the matching pending
      // entry; only re-apply if it wasn't done optimistically already.
      const pending = state._pendingSubmits.shift();
      if (!pending?.applied) {
        state.bigRenderer.clearCells(cells);
        state.miniRenderers.get(player_id)?.clearCells(cells);
      }
      state.miniRenderers.get(player_id)?.setMyDrag(null);
      state.bigRenderer.setMyDrag(null);
      audio.clearSfx(cells?.length ?? 0);
    } else {
      const mini = state.miniRenderers.get(player_id);
      if (mini) {
        mini.clearCells(cells);
        mini.setMyDrag(null);
      }
      if (player_id === state.focusedPlayerId) {
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
  });

  ws.addEventListener("msg:reject", () => {
    // Roll back the optimistic apply for the matching pending submit.
    const pending = state._pendingSubmits.shift();
    if (pending?.applied && pending.cells.length > 0) {
      state.bigRenderer.restoreCells(pending.cells);
      state.miniRenderers.get(state.playerId)?.restoreCells(pending.cells);
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
  if (me) {
    state.myName = me.nickname;
    state.inventory = Array.isArray(me.inventory)
      ? [me.inventory[0] ?? null, me.inventory[1] ?? null, me.inventory[2] ?? null]
      : [null, null, null];
    setCombo(typeof me.combo === "number" ? me.combo : 0);
  }
  renderInventory();
  state.initialGolden = Array.isArray(m.initial_golden)
    ? m.initial_golden.map(([r, c]) => [r, c])
    : [];

  // Build leaderboard, then set each player's current board state
  buildLeaderboard();
  if (m.boards) {
    for (const [pid, board] of Object.entries(m.boards)) {
      const mini = state.miniRenderers.get(pid);
      if (mini) mini.setBoard(board);
    }
  }
  // Re-stamp goldens that are still in play. Server sends a per-player
  // dict so partial pickups are honoured rather than reset to the
  // initial set.
  if (state.variant === "items" && m.golden && typeof m.golden === "object") {
    for (const [pid, cells] of Object.entries(m.golden)) {
      const renderer = state.miniRenderers.get(pid);
      if (!renderer) continue;
      renderer.clearGolden();
      for (const [r, c] of cells) renderer.setGolden(r, c, true);
    }
  }
  // Restore focus to me — also copies my current board onto the big
  // renderer and (critically) re-enables drag input which is gated by
  // focusedPlayerId === playerId.
  setFocusedPlayer(state.playerId, /*forceCopy*/ true);
  // Mark currently disconnected peers
  for (const p of m.room.players) {
    if (p.connected === false) {
      const item = state.lbItems.get(p.id);
      if (item) item.li.classList.add("disconnected");
    }
  }
  // Restore active effects (blind / shield / hint) from the events log.
  // Pair every effect_start with its effect_end; anything still open and
  // not yet expired needs its visual re-applied so the player sees the
  // same state they had before disconnect.
  if (state.variant === "items") {
    const nowMs = Date.now();
    const open = new Map();  // "target_id|effect" -> effect_start event
    for (const ev of state.events) {
      if (ev.kind === "effect_start") {
        open.set(`${ev.target_id}|${ev.effect}`, ev);
      } else if (ev.kind === "effect_end") {
        open.delete(`${ev.target_id}|${ev.effect}`);
      }
    }
    for (const ev of open.values()) {
      if (ev.until_ms && ev.until_ms <= nowMs) continue;
      applyEffectStart(ev.target_id, ev.effect, ev.until_ms, ev.hint);
    }
  }
  reorderAndRankLeaderboard();

  if (m.state === "playing") {
    show("game");
    startTimer();
    startProgress();
    maybeShowStartCountdown();
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

// ---- Inventory / toast / effects ----
function renderInventory() {
  const visible = state.variant === "items";
  $("inventory").hidden = !visible;
  $("mobileInventory").hidden = !visible;
  const remaining = state.endsAt ? state.endsAt - Date.now() : 0;
  const locked = remaining > 0 && remaining <= 10_000;
  for (const btn of document.querySelectorAll(".inv-slot")) {
    const slot = parseInt(btn.dataset.slot, 10);
    const item = state.inventory[slot];
    if (item && ITEM_META[item]) {
      btn.classList.add("has-item");
      // Icon + ✕ button (corner discard). Re-render rather than mutate so
      // we don't need to track per-slot child nodes across re-renders.
      btn.innerHTML =
        `<span class="inv-icon">${icon(item)}</span>` +
        `<span class="inv-x" role="button" aria-label="버리기" title="버리기 (우클릭/롱프레스)">${icon("discard")}</span>`;
      const isAttack = ITEM_META[item].attack;
      btn.classList.toggle("locked", isAttack && locked);
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
      // Shield draws as an inset ring; show a corner crest instead of a
      // centred label so the board stays readable.
      el.innerHTML = `<span class="effect-corner">${icon("shield")}</span>`;
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
  } else if (target_id === state.playerId && meta.attack) {
    if (blocked) {
      showItemToast(`${shieldTag}<span>${byName}님의 ${meta.label} 방어!</span>`);
    } else {
      showAttackToast(labelWithIcon(item, `${byName}님이 ${meta.label}!`));
    }
  } else if (meta.attack && target_id) {
    const target = state.room?.players.find((p) => p.id === target_id);
    const tName = escapeHtml(target?.nickname ?? "?");
    showItemToast(labelWithIcon(item, `${byName} → ${tName} (${meta.label})`) + blockSuffix);
  }
}

function applyEffectStart(target_id, effect, until_ms, hint) {
  const remainingMs = (until_ms ?? Date.now()) - Date.now();
  if (target_id === state.playerId) {
    if (effect === "shield") {
      state.effects.shield = until_ms;
      showBoardEffect("shield", remainingMs);
    } else if (effect === "blind") {
      state.effects.blind = until_ms;
      state.bigRenderer.setBlind(true);
      state.miniRenderers.get(state.playerId)?.setBlind(true);
      // Hide any sum badge from an in-progress drag started before blind hit.
      sumBadge.hidden = true;
      showBoardEffect("blind", remainingMs);
    } else if (effect === "overload") {
      state.effects.overload = until_ms;
      state.bigRenderer.setOverload(true);
      state.miniRenderers.get(state.playerId)?.setOverload(true);
      sumBadge.hidden = true;
      showBoardEffect("overload", remainingMs);
    } else if (effect === "freeze") {
      state.effects.freeze = until_ms;
      // Kill any in-progress drag so the lock feels immediate.
      sumBadge.hidden = true;
      state.bigRenderer.setMyDrag(null);
      state.miniRenderers.get(state.playerId)?.setMyDrag(null);
      showBoardEffect("freeze", remainingMs);
    } else if (effect === "hint" && Array.isArray(hint)) {
      const cells = hint.map((h) => [h.r, h.c]);
      state.bigRenderer.setHint(cells);
      state.miniRenderers.get(state.playerId)?.setHint(cells);
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
  if (effect === "shield" && target_id === state.playerId) {
    state.effects.shield = 0;
    hideBoardEffect("shield");
  } else if (effect === "blind") {
    if (target_id === state.playerId) state.effects.blind = 0;
    const mini = state.miniRenderers.get(target_id);
    mini?.setBlind(false);
    if (target_id === state.focusedPlayerId || target_id === state.playerId) {
      state.bigRenderer.setBlind(false);
    }
    if (target_id === state.playerId) hideBoardEffect("blind");
  } else if (effect === "overload") {
    if (target_id === state.playerId) state.effects.overload = 0;
    state.miniRenderers.get(target_id)?.setOverload(false);
    if (target_id === state.focusedPlayerId || target_id === state.playerId) {
      state.bigRenderer.setOverload(false);
    }
    if (target_id === state.playerId) hideBoardEffect("overload");
  } else if (effect === "freeze") {
    if (target_id === state.playerId) {
      state.effects.freeze = 0;
      hideBoardEffect("freeze");
    }
  } else if (effect === "hint") {
    state.bigRenderer.setHint(null);
    state.miniRenderers.get(state.playerId)?.setHint(null);
  }
}

function applyShuffle(target_id, board, animate) {
  const mini = state.miniRenderers.get(target_id);
  mini?.setBoard(board);
  if (target_id === state.focusedPlayerId) {
    state.bigRenderer.setBoard(board);
    if (animate) state.bigRenderer.shakeOnce?.();
  }
  if (target_id === state.playerId) {
    state.bigRenderer.shakeOnce?.();
    if (animate) {
      showBoardEffect("shuffle", 600);
      setTimeout(() => hideBoardEffect("shuffle"), 600);
    }
  }
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

// ---- Game lifecycle ----
function onGameStart(m) {
  state.endsAt = m.ends_at * 1000;
  state.startedAt = state.endsAt - GAME_DURATION_MS;
  state.events = [];
  state.variant = m.variant || state.variant || "classic";
  state.inventory = [null, null, null];
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
  for (const p of state.room?.players ?? []) state.scores[p.id] = 0;
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
  if (state.variant === "items") applyInitialGoldenToAll();
  // Default focus = me
  setFocusedPlayer(state.playerId, /*forceCopy*/ false);
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

    if (isMe && canRenameMe) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "nick-edit-btn";
      editBtn.setAttribute("aria-label", "닉네임 변경");
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => beginNicknameEdit(li, nameSpan));
      li.appendChild(editBtn);
    } else {
      li.appendChild(document.createElement("span"));  // spacer for grid
    }
    list.appendChild(li);
  }
  const cnt = state.room.players.length;
  const cap = state.room.capacity ?? 2;
  $("playerCount").textContent = `${cnt} / ${cap}`;
  const isHost = state.playerId === state.hostId;
  const canStart = state.mode === "friend" && isHost && cnt >= 2;
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
    if (isHost && state.variant === "items") {
      const chips = ["hint", "blind", "shuffle", "shield"]
        .map((k) => `<span class="ico">${icon(k)}</span>`)
        .join(" ");
      $("variantHelper").innerHTML =
        `황금 사과를 합10에 포함시키면 랜덤 아이템 (${chips}) 획득`;
    } else {
      $("variantHelper").textContent = isHost
        ? "원하면 아이템전으로 바꿔보세요"
        : `호스트가 모드를 정합니다 (현재 ${state.variant === "items" ? "아이템전" : "클래식"})`;
    }
  }

  // Nickname editing in the player list is gated on state.mode in
  // renderLobby's player loop — nothing extra to do here for random.

  if (state.mode === "friend") {
    if (cnt < 2) {
      $("lobbyMsg").textContent = "친구에게 코드 또는 초대 링크를 공유하세요.";
    } else if (isHost) {
      $("lobbyMsg").textContent = cnt < cap
        ? "지금 시작하거나 더 기다릴 수 있어요."
        : "방이 가득 찼습니다. 시작 버튼을 누르세요.";
    } else {
      $("lobbyMsg").textContent = "방장이 시작하기를 기다리는 중…";
    }
  } else if (state.mode === "random") {
    if (cnt < 2) {
      $("lobbyMsg").textContent = `상대를 기다리는 중... (${cnt}/${cap})`;
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
  const players = state.room?.players ?? [];
  for (const p of players) {
    const li = document.createElement("li");
    li.className = "lb-item";
    if (p.id === state.playerId) li.classList.add("me");
    li.dataset.playerId = p.id;

    const rankEl = document.createElement("span");
    rankEl.className = "lb-rank";
    rankEl.textContent = "#-";
    const nameEl = document.createElement("span");
    nameEl.className = "lb-name";
    nameEl.textContent = p.nickname + (p.id === state.playerId ? " (me)" : "");
    const scoreEl = document.createElement("span");
    scoreEl.className = "lb-score";
    scoreEl.textContent = "0";

    const row = document.createElement("div");
    row.className = "lb-row";
    row.append(rankEl, nameEl, scoreEl);

    const c = document.createElement("canvas");
    c.className = "lb-mini";
    li.append(row, c);
    ul.appendChild(li);

    li.addEventListener("click", () => setFocusedPlayer(p.id));

    const renderer = new BoardRenderer(c, { mini: true });
    if (state.initialBoard) renderer.setBoard(state.initialBoard);
    state.miniRenderers.set(p.id, renderer);
    state.lbItems.set(p.id, { li, rankEl, nameEl, scoreEl });
  }
  $("lbCount").textContent = String(players.length);
  $("totalPlayers").textContent = String(players.length);
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
  // Label only when looking at someone else
  const label = $("focusLabel");
  if (pid === state.playerId) {
    label.hidden = true;
    label.classList.remove("viewing");
  } else {
    const player = state.room?.players.find((p) => p.id === pid);
    label.textContent = `${player?.nickname ?? "?"}의 보드`;
    label.hidden = false;
    label.classList.add("viewing");
  }
  // Close mobile drawer after picking
  screens.game.classList.remove("drawer-open");
}

function reorderAndRankLeaderboard(scoresOverride = null) {
  const scores = scoresOverride || state.scores;
  const players = state.room?.players ?? [];
  // Sort by score desc, tiebreak by nickname for stability
  const ranked = players.slice().sort((a, b) => {
    const da = scores[a.id] || 0;
    const db = scores[b.id] || 0;
    if (db !== da) return db - da;
    return a.nickname.localeCompare(b.nickname);
  });
  ranked.forEach((p, idx) => {
    const item = state.lbItems.get(p.id);
    if (!item) return;
    item.li.style.order = String(idx);
    item.rankEl.textContent = `#${idx + 1}`;
    item.scoreEl.textContent = String(scores[p.id] || 0);
    if (p.id === state.playerId) {
      $("myRank").textContent = `#${idx + 1}`;
      $("myScoreNum").textContent = String(scores[p.id] || 0);
      $("miniScore").textContent = String(scores[p.id] || 0);
      state.myScore = scores[p.id] || 0;
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
    if (state.variant === "items") {
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
  const replaySub = "🔁 리플레이 자동 재생 중 — 닫기를 누르면 멈춥니다";
  if (state.mode === "solo") {
    title = `점수 ${scores[state.playerId] ?? 0} / 170`;
    subtitle = replaySub;
  } else if (winner_id === null || winner_id === undefined) {
    title = "무승부 🤝";
    subtitle = replaySub;
  } else if (winner_id === state.playerId) {
    title = "승리! 🎉";
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
  for (const p of state.room?.players ?? []) state.replayCumScores[p.id] = 0;

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
  if (state.variant === "items") applyInitialGoldenToAll();
  state.scores = { ...state.replayCumScores };
  reorderAndRankLeaderboard();

  // Show controls; hide the top progress bar so it doesn't duplicate
  // the scrubber. We're already on the game screen.
  $("replayControls").hidden = false;
  $("topProgress").hidden = true;
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
    if (state.variant === "items") applyInitialGoldenToAll();
    state.replayCumScores = {};
    for (const p of state.room?.players ?? []) state.replayCumScores[p.id] = 0;
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

// Close (just stops the replay; user stays on result mode and can scrub
// or hit 새 게임 / 홈으로 in the result banner)
$("replayClose").addEventListener("click", () => exitReplay());

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
