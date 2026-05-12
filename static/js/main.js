import { GameSocket } from "./ws.js";
import { BoardRenderer } from "./board.js";
import { attachDragInput } from "./input.js";

const $ = (id) => document.getElementById(id);
const GAME_DURATION_MS = 120 * 1000;

const screens = {
  home: $("home"),
  helpScreen: $("helpScreen"),
  joinScreen: $("joinScreen"),
  lobby: $("lobby"),
  game: $("game"),
};

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
  effects: { bonus: 0, blind: 0, hint: 0 },  // expiry ms
  effectTimers: {},
  initialGolden: [],   // [[r,c], ...] picked at game start
  combo: 0,
};

const ITEM_META = {
  hint:    { icon: "🔍", label: "힌트",  attack: false, desc: "내 보드에 합10 쌍 강조 (3초)" },
  bonus:   { icon: "➕", label: "추가 점수", attack: false, desc: "8초간 클리어할 때마다 점수 +1" },
  blind:   { icon: "🙈", label: "숫자 숨김", attack: true, desc: "상대 1명 숫자 3초 가림" },
  shuffle: { icon: "🔀", label: "셔플", attack: true, desc: "상대 1명 보드 재배치" },
};

const sumBadge = $("sumBadge");
const canvas = $("board");
state.bigRenderer = new BoardRenderer(canvas);

// Queue of submits awaiting server confirmation. Used to (a) skip the
// re-apply when our own clear comes back and (b) roll the optimistic
// apply back on reject.
state._pendingSubmits = [];

attachDragInput(canvas, state.bigRenderer, {
  onUpdate: (rect) => {
    if (state.replayActive) return;
    if (state.focusedPlayerId !== state.playerId) return; // viewing only
    state.ws?.send("drag_update", rect);
    const sum = state.bigRenderer.sumIn(rect);
    sumBadge.hidden = false;
    sumBadge.textContent = String(sum);
    sumBadge.classList.toggle("ten", sum === 10);
    const center = state.bigRenderer.rectCenter(rect);
    if (center) {
      sumBadge.style.left = center.x + "px";
      sumBadge.style.top = center.y + "px";
    }
    // Mirror onto my own mini so the leaderboard shows my live drag
    state.miniRenderers.get(state.playerId)?.setMyDrag(rect);
  },
  onSubmit: (rect) => {
    sumBadge.hidden = true;
    if (state.replayActive) return;
    if (state.focusedPlayerId !== state.playerId) return;

    // Optimistic local clear — apply immediately if the rect locally
    // sums to 10, so users see the apples vanish without waiting for
    // a network round trip. Server stays authoritative; on reject we
    // roll back via restoreCells.
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
    let applied = false;
    if (total === 10 && cellsWithValue.length > 0) {
      const arr = cellsWithValue.map((c) => [c.r, c.c]);
      state.bigRenderer.clearCells(arr);
      state.miniRenderers.get(state.playerId)?.clearCells(arr);
      applied = true;
    }
    state._pendingSubmits.push({ cells: cellsWithValue, applied });
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
    const intent = btn.dataset.intent;
    if (intent === "join-open") {
      $("joinCode").value = "";
      show("joinScreen");
      $("joinCode").focus();
      return;
    }
    await startSession(intent);
  });
});

// ---- Help screen ----
$("helpOpenBtn")?.addEventListener("click", () => show("helpScreen"));
$("helpBackBtn")?.addEventListener("click", () => show("home"));

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
document.querySelectorAll(".inv-slot").forEach((btn) => {
  btn.addEventListener("click", () => {
    const slot = parseInt(btn.dataset.slot, 10);
    if (!Number.isInteger(slot)) return;
    if (!state.inventory[slot]) return;
    if (btn.classList.contains("locked")) {
      showItemToast("⏳ 마지막 10초엔 공격 아이템을 쓸 수 없어요");
      return;
    }
    state.ws?.send("use_item", { slot });
  });
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

async function startSession(intent, code = null) {
  state.intent = intent;
  state.ws = new GameSocket();
  bindSocket(state.ws);
  await state.ws.connect();
  state.ws.send("hello", { intent, code });

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
$("rematchBtn").addEventListener("click", () => {
  exitReplay();
  state.ws?.send("rematch");
});

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
$("cornerHomeBtn").addEventListener("click", () => leaveAndGoHome());

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
  $("resultBanner").hidden = true;
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
  state.effects = { bonus: 0, blind: 0, hint: 0 };
  state.initialGolden = [];
  $("inventory").hidden = true;
  $("mobileInventory").hidden = true;
  document.querySelectorAll(".board-effect-overlay").forEach((el) => el.remove());
  if (state.matchTickerId) {
    clearInterval(state.matchTickerId);
    state.matchTickerId = null;
  }
  state.miniRenderers.clear();
  state.lbItems.clear();
  $("lbList").innerHTML = "";
  $("progressFill").style.width = "0%";
  $("verticalProgressFill").style.width = "0%";
  $("miniScore").textContent = "0";
  $("miniTimer").textContent = "2:00";
  $("resultBanner").hidden = true;
  $("topProgress").hidden = false;
  $("focusLabel").hidden = true;
  screens.game.classList.remove("drawer-open");
}

// ---- Socket bindings ----
function bindSocket(ws) {
  ws.addEventListener("close", () => {
    // If the close came before any screen was shown (e.g. reconnect
    // attempt aborted), default to home.
    if (allScreensHidden()) {
      show("home");
      return;
    }
    if (!screens.home.hidden) return;
    alert("연결이 종료되었습니다.");
    resetState();
    show("home");
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
    if (meta) showItemToast(`${meta.icon} ${meta.label} 획득!`);
  });

  ws.addEventListener("msg:item_used", (e) => {
    const { by, item, target_id, slot, t_ms } = e.detail;
    state.events.push({ kind: "item_used", t_ms: t_ms ?? 0, by, item, target_id });
    // Server clears the slot — mirror that locally so the inventory UI
    // empties immediately for the player who triggered the use.
    if (by === state.playerId && typeof slot === "number") {
      state.inventory[slot] = null;
      renderInventory();
    }
    showItemUsedToast(by, item, target_id);
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
    $("topProgress").hidden = false;
    state.events = [];
    state.scores = {};
    state.gameWinnerId = null;
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
  state.events = (m.events || []).map((e) => ({
    t_ms: e.t_ms, player_id: e.player_id, cells: e.cells,
  }));
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
  reorderAndRankLeaderboard();

  if (m.state === "playing") {
    show("game");
    startTimer();
    startProgress();
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
      btn.textContent = ITEM_META[item].icon;
      btn.title = `${ITEM_META[item].label} — ${ITEM_META[item].desc}`;
      const isAttack = ITEM_META[item].attack;
      btn.classList.toggle("locked", isAttack && locked);
    } else {
      btn.classList.remove("has-item", "locked");
      btn.textContent = "";
      btn.title = "";
    }
  }
}

let _itemToastTimer = null;
function showItemToast(msg) {
  const el = $("itemToast");
  el.textContent = msg;
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
function showAttackToast(msg) {
  const el = $("attackToast");
  el.textContent = msg;
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
    const labels = { bonus: "+1 SCORE", blind: "🙈 숫자 숨김", shuffle: "🔀 SHUFFLE" };
    el.textContent = labels[kind] || "";
    document.querySelector(".board-area").appendChild(el);
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

function showItemUsedToast(by, item, target_id) {
  const meta = ITEM_META[item];
  if (!meta) return;
  const byPlayer = state.room?.players.find((p) => p.id === by);
  const byName = byPlayer?.nickname ?? "?";
  if (by === state.playerId) {
    showItemToast(`${meta.icon} ${meta.label} 사용`);
  } else if (target_id === state.playerId && meta.attack) {
    showAttackToast(`${byName}님이 ${meta.icon} ${meta.label}!`);
  } else if (meta.attack && target_id) {
    const target = state.room?.players.find((p) => p.id === target_id);
    const tName = target?.nickname ?? "?";
    showItemToast(`${byName} → ${tName} (${meta.icon} ${meta.label})`);
  }
}

function applyEffectStart(target_id, effect, until_ms, hint) {
  const remainingMs = (until_ms ?? Date.now()) - Date.now();
  if (target_id === state.playerId) {
    if (effect === "bonus") {
      state.effects.bonus = until_ms;
      showBoardEffect("bonus", remainingMs);
    } else if (effect === "blind") {
      state.effects.blind = until_ms;
      state.bigRenderer.setBlind(true);
      state.miniRenderers.get(state.playerId)?.setBlind(true);
      showBoardEffect("blind", remainingMs);
    } else if (effect === "hint" && Array.isArray(hint)) {
      const cells = hint.map((h) => [h.r, h.c]);
      state.bigRenderer.setHint(cells);
      state.miniRenderers.get(state.playerId)?.setHint(cells);
    }
  } else if (effect === "blind") {
    const mini = state.miniRenderers.get(target_id);
    mini?.setBlind(true);
    if (target_id === state.focusedPlayerId) state.bigRenderer.setBlind(true);
  }
}

function applyEffectEnd(target_id, effect) {
  if (effect === "bonus" && target_id === state.playerId) {
    state.effects.bonus = 0;
    hideBoardEffect("bonus");
  } else if (effect === "blind") {
    if (target_id === state.playerId) state.effects.blind = 0;
    const mini = state.miniRenderers.get(target_id);
    mini?.setBlind(false);
    if (target_id === state.focusedPlayerId || target_id === state.playerId) {
      state.bigRenderer.setBlind(false);
    }
    if (target_id === state.playerId) hideBoardEffect("blind");
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
  state.bigRenderer.setHint(null);
  state.bigRenderer.clearGolden();
  for (const r of state.miniRenderers.values()) {
    r.setBlind(false);
    r.setHint(null);
    r.clearGolden();
  }
  hideBoardEffect("bonus");
  hideBoardEffect("blind");
  hideBoardEffect("shuffle");
  setCombo(0);
}

function setCombo(n, triggered = false) {
  state.combo = n;
  const badge = $("comboBadge");
  const mob = $("mobileCombo");
  const icon = badge.querySelector(".combo-icon");
  const text = badge.querySelector(".combo-text");
  const badgeTrigger = badge.querySelector(".combo-trigger-msg");
  const mobDefault = mob.querySelector(".mobile-combo-default");
  const mobTrigger = mob.querySelector(".mobile-combo-trigger");
  clearTimeout(state._comboMessageTimer);

  if (triggered) {
    // In-place swap: hide the normal icon+text, show the trigger pill.
    icon.hidden = true;
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
      icon.hidden = false;
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
  icon.hidden = false;
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
  state.effects = { bonus: 0, blind: 0, hint: 0 };
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
  requestAnimationFrame(() => {
    state.bigRenderer.resize();
    for (const r of state.miniRenderers.values()) r.resize();
  });
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
    $("variantHelper").textContent = isHost
      ? (state.variant === "items"
          ? "황금 사과를 합10에 포함시키면 랜덤 아이템 (🔍힌트 ⚡2배 🙈숨김 🔀셔플) 획득"
          : "원하면 아이템전으로 바꿔보세요")
      : `호스트가 모드를 정합니다 (현재 ${state.variant === "items" ? "아이템전" : "클래식"})`;
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
    const remaining = Math.max(0, state.endsAt - Date.now());
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
    const elapsed = Date.now() - startTs;
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

  let title = "결과";
  let subtitle = "";
  if (state.mode === "solo") {
    title = `점수 ${scores[state.playerId] ?? 0} / 170`;
    subtitle = "리플레이가 자동 재생됩니다";
  } else if (winner_id === null || winner_id === undefined) {
    title = "무승부 🤝";
    subtitle = "리플레이를 둘러보세요";
  } else if (winner_id === state.playerId) {
    title = "승리! 🎉";
    subtitle = "리플레이를 둘러보세요";
  } else {
    title = "패배 😢";
    subtitle = "리플레이를 둘러보세요";
  }
  $("resultTitle").textContent = title;
  $("resultSubtitle").textContent = subtitle;

  // Show result banner + new game/home buttons
  const players = state.room?.players ?? [];
  const enough = players.length >= 2;
  const canRematch =
    state.mode === "solo"
      ? true
      : state.mode === "friend"
        ? (state.playerId === state.hostId && enough)
        : enough;
  $("rematchBtn").hidden = !canRematch;
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
      if (animate) showItemUsedToast(ev.by, ev.item, ev.target_id);
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
  $("replayPlayPause").textContent = state.replayPaused ? "▶" : "❚❚";
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
