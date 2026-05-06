import { GameSocket } from "./ws.js";
import { BoardRenderer } from "./board.js";
import { attachDragInput } from "./input.js";

const $ = (id) => document.getElementById(id);
const GAME_DURATION_MS = 120 * 1000;

const screens = {
  home: $("home"),
  joinScreen: $("joinScreen"),
  lobby: $("lobby"),
  game: $("game"),
  result: $("result"),
};

function show(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
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
};

const sumBadge = $("sumBadge");
const canvas = $("board");
state.bigRenderer = new BoardRenderer(canvas);

attachDragInput(canvas, state.bigRenderer, {
  onUpdate: (rect) => {
    if (state.replayActive) return;
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
  },
  onSubmit: (rect) => {
    sumBadge.hidden = true;
    if (state.replayActive) return;
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
      return;
    } catch {
      clearSession();
    }
  }
  // 2) Else, fall back to ?room=XXXXXX auto-join
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || "").trim().toUpperCase();
  if (code.length === 6) {
    history.replaceState(null, "", location.pathname);
    startSession("join", code);
  }
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
  exitReplay(false);
  state.ws?.send("rematch");
});
$("replayBtn").addEventListener("click", () => startReplay());

// ESC exits replay early
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.replayActive) {
    exitReplay(true);
  }
});

const nickInput = $("nickInput");
nickInput.addEventListener("change", commitNickname);
nickInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nickInput.blur();
  }
});

function commitNickname() {
  const v = nickInput.value.trim().slice(0, 20);
  if (!v || v === state.myName) {
    nickInput.value = state.myName;
    return;
  }
  state.ws?.send("rename", { nickname: v });
  state.myName = v;
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
  exitReplay(false);
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
  state.miniRenderers.clear();
  state.lbItems.clear();
  $("lbList").innerHTML = "";
  $("nickInput").value = "";
  $("progressFill").style.width = "0%";
}

// ---- Socket bindings ----
function bindSocket(ws) {
  ws.addEventListener("close", () => {
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
    if (me) {
      state.myName = me.nickname;
      nickInput.value = me.nickname;
    }
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
    if (player_id === state.playerId) {
      state.myName = nickname;
      if (document.activeElement !== nickInput) nickInput.value = nickname;
    }
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

  ws.addEventListener("msg:queued", (e) => {
    $("lobbyMsg").textContent = `매칭 대기열 ${e.detail.position}번째…`;
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
    const renderer = state.miniRenderers.get(player_id);
    renderer?.setMyDrag({ r1, c1, r2, c2 });
  });

  ws.addEventListener("msg:clear", (e) => {
    const { cells, scores, player_id, t_ms } = e.detail;
    state.events.push({ t_ms: t_ms ?? 0, player_id, cells });
    if (player_id === state.playerId) {
      state.bigRenderer.clearCells(cells);
    }
    const mini = state.miniRenderers.get(player_id);
    if (mini) {
      mini.clearCells(cells);
      mini.setMyDrag(null);
    }
    state.scores = scores;
    reorderAndRankLeaderboard();
  });

  ws.addEventListener("msg:reject", () => {
    // Optional visual feedback
  });

  ws.addEventListener("msg:game_end", (e) => {
    showResult(e.detail);
    clearSession();
  });

  ws.addEventListener("msg:error", (e) => {
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
    nickInput.value = me.nickname;
  }

  // Build leaderboard, then set each player's current board state
  buildLeaderboard();
  if (m.boards) {
    const myBoard = m.boards[state.playerId];
    if (myBoard) state.bigRenderer.setBoard(myBoard);
    for (const [pid, board] of Object.entries(m.boards)) {
      const mini = state.miniRenderers.get(pid);
      if (mini) mini.setBoard(board);
    }
  }
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

// ---- Game lifecycle ----
function onGameStart(m) {
  state.endsAt = m.ends_at * 1000;
  state.startedAt = state.endsAt - GAME_DURATION_MS;
  state.events = [];
  state.initialBoard = m.board.map((row) => row.slice());
  state.scores = {};
  for (const p of state.room?.players ?? []) state.scores[p.id] = 0;

  state.bigRenderer.setBoard(m.board);
  state.bigRenderer.setMyDrag(null);

  buildLeaderboard();
  reorderAndRankLeaderboard();

  show("game");
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
  $("roomCode").textContent = room.id;
  $("roomCodeSection").hidden = (room.mode === "solo" || room.mode === "random");
  renderLobby();
}

function renderLobby() {
  if (!state.room) return;
  const list = $("playerList");
  list.innerHTML = "";
  for (const p of state.room.players) {
    const li = document.createElement("li");
    if (p.id === state.hostId) li.classList.add("host");
    const me = p.id === state.playerId ? " (나)" : "";
    li.innerHTML = `<span>${escapeHtml(p.nickname)}${me}</span><span></span>`;
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
  }
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

    const renderer = new BoardRenderer(c, { mini: true });
    if (state.initialBoard) renderer.setBoard(state.initialBoard);
    state.miniRenderers.set(p.id, renderer);
    state.lbItems.set(p.id, { li, rankEl, nameEl, scoreEl });
  }
  $("lbCount").textContent = String(players.length);
  $("totalPlayers").textContent = String(players.length);
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
      state.myScore = scores[p.id] || 0;
    }
  });
}

// ---- Timer / Progress ----
function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  const tick = () => {
    const remaining = Math.max(0, state.endsAt - Date.now());
    const sec = Math.ceil(remaining / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const el = $("timer");
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.classList.toggle("warn", sec <= 30 && sec > 10);
    el.classList.toggle("danger", sec <= 10);
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
  fill.classList.remove("warn", "danger");
  const tick = () => {
    const elapsed = Date.now() - startTs;
    const pct = Math.min(100, (elapsed / GAME_DURATION_MS) * 100);
    fill.style.width = pct + "%";
    const remaining = GAME_DURATION_MS - elapsed;
    fill.classList.toggle("warn", remaining <= 30000 && remaining > 10000);
    fill.classList.toggle("danger", remaining <= 10000);
    if (elapsed >= GAME_DURATION_MS) {
      clearInterval(state.progressInterval);
      state.progressInterval = null;
    }
  };
  tick();
  state.progressInterval = setInterval(tick, 100);
}

// ---- Result ----
function showResult(detail) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.progressInterval) clearInterval(state.progressInterval);
  state.timerInterval = null;
  state.progressInterval = null;

  const { scores, winner_id } = detail;
  const list = $("finalScores");
  list.innerHTML = "";
  const players = state.room?.players ?? [];
  const ordered = players.slice().sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0));
  for (const p of ordered) {
    const li = document.createElement("li");
    if (p.id === winner_id) li.classList.add("winner");
    const meLabel = p.id === state.playerId ? " (나)" : "";
    const score = scores[p.id] ?? 0;
    li.innerHTML = `<span>${escapeHtml(p.nickname)}${meLabel}</span><strong>${score}</strong>`;
    list.appendChild(li);
  }
  let title = "결과";
  if (state.mode === "solo") {
    title = `점수: ${scores[state.playerId] ?? 0} / 170`;
  } else if (winner_id === null || winner_id === undefined) {
    title = "무승부 🤝";
  } else if (winner_id === state.playerId) {
    title = "승리! 🎉";
  } else {
    title = "패배 😢";
  }
  $("resultTitle").textContent = title;

  // New game button: solo always; friend host with >= 2 players; random with full
  const enough = players.length >= 2;
  const canRematch =
    state.mode === "solo"
      ? true
      : state.mode === "friend"
        ? (state.playerId === state.hostId && enough)
        : enough;
  $("rematchBtn").hidden = !canRematch;
  $("replayBtn").hidden = state.events.length === 0;
  show("result");
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
  state.scores = { ...state.replayCumScores };
  reorderAndRankLeaderboard();

  // Show controls and switch to game screen; hide the top progress bar
  // so it doesn't duplicate the scrubber.
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

function exitReplay(returnToResult) {
  if (!state.replayActive) return;
  state.replayActive = false;
  if (state.replayRafId) cancelAnimationFrame(state.replayRafId);
  state.replayRafId = null;
  $("replayControls").hidden = true;
  $("topProgress").hidden = false;
  if (returnToResult) show("result");
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
    if (ev.t_ms > fromMs && ev.t_ms <= toMs) {
      const mini = state.miniRenderers.get(ev.player_id);
      const isMe = ev.player_id === state.playerId;
      if (animate) {
        mini?.clearCells(ev.cells);
        if (isMe) state.bigRenderer.clearCells(ev.cells);
      } else {
        mini?.applyClear(ev.cells);
        if (isMe) state.bigRenderer.applyClear(ev.cells);
      }
      state.replayCumScores[ev.player_id] =
        (state.replayCumScores[ev.player_id] || 0) + ev.cells.length;
    }
  }
  state.scores = { ...state.replayCumScores };
}

function replaySeekTo(targetMs) {
  targetMs = Math.max(0, Math.min(GAME_DURATION_MS, targetMs));
  if (targetMs >= state.replayTime) {
    applyReplayEventsBetween(state.replayTime, targetMs, /*animate*/ false);
  } else {
    // Backward: rebuild from initial
    state.bigRenderer.setBoard(state.initialBoard);
    for (const r of state.miniRenderers.values()) r.setBoard(state.initialBoard);
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
  $("replayCurrent").textContent = formatMmSs(state.replayTime);
  // Top-bar timer counts down so it matches the live game look
  const remaining = Math.max(0, GAME_DURATION_MS - state.replayTime);
  const timerEl = $("timer");
  timerEl.textContent = formatMmSs(remaining);
  const remSec = Math.ceil(remaining / 1000);
  timerEl.classList.toggle("warn", remSec <= 30 && remSec > 10);
  timerEl.classList.toggle("danger", remSec <= 10);
  const fill = $("progressFill");
  fill.classList.toggle("warn", remaining <= 30000 && remaining > 10000);
  fill.classList.toggle("danger", remaining <= 10000);
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

// Close
$("replayClose").addEventListener("click", () => exitReplay(true));

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
