import { GameSocket } from "./ws.js";
import { BoardRenderer } from "./board.js";
import { attachDragInput } from "./input.js";

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("home"),
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
  timerInterval: null,
  myScore: 0,
  oppScore: 0,
  oppName: "상대",
  myName: "나",
  renderer: null,
  hostId: null,
  mode: null,
  intent: null,
};

const sumBadge = $("sumBadge");
const canvas = $("board");
state.renderer = new BoardRenderer(canvas);

attachDragInput(canvas, state.renderer, {
  onUpdate: (rect) => {
    state.ws?.send("drag_update", rect);
    const sum = state.renderer.sumIn(rect);
    sumBadge.hidden = false;
    sumBadge.textContent = String(sum);
    sumBadge.classList.toggle("ten", sum === 10);
    const center = state.renderer.rectCenter(rect);
    if (center) {
      sumBadge.style.left = center.x + "px";
      sumBadge.style.top = center.y + "px";
    }
  },
  onSubmit: (rect) => {
    sumBadge.hidden = true;
    state.ws?.send("submit", rect);
  },
});

// ---- Home screen ----
$("nickname").value = localStorage.getItem("nickname") || "";

document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const intent = btn.dataset.intent;
    if (intent === "join-open") {
      $("joinRow").hidden = !$("joinRow").hidden;
      return;
    }
    await startSession(intent);
  });
});

$("joinSubmit").addEventListener("click", async () => {
  const code = $("joinCode").value.trim().toUpperCase();
  if (code.length !== 6) {
    alert("6자리 코드를 입력하세요.");
    return;
  }
  await startSession("join", code);
});

async function startSession(intent, code = null) {
  const nickname = $("nickname").value.trim().slice(0, 20) || "Anonymous";
  localStorage.setItem("nickname", nickname);
  state.intent = intent;
  state.myName = nickname;

  state.ws = new GameSocket();
  bindSocket(state.ws);
  await state.ws.connect();
  state.ws.send("hello", { nickname, intent, code });

  // Show lobby until joined / game starts
  $("lobbyTitle").textContent =
    intent === "match" ? "랜덤 매칭 중…" :
    intent === "solo" ? "혼자 연습 시작…" :
    intent === "create" ? "방 생성 중…" : "방 입장 중…";
  $("lobbyMsg").textContent = intent === "match" ? "상대를 찾고 있습니다." : "잠시만 기다려 주세요.";
  $("startBtn").hidden = true;
  $("roomCode").textContent = "------";
  $("playerList").innerHTML = "";
  show("lobby");
}

$("cancelBtn").addEventListener("click", () => leaveAndGoHome());
$("homeBtn").addEventListener("click", () => leaveAndGoHome());
$("startBtn").addEventListener("click", () => state.ws?.send("start"));
$("rematchBtn").addEventListener("click", () => state.ws?.send("rematch"));

function leaveAndGoHome() {
  state.ws?.send("leave");
  state.ws?.close();
  resetState();
  show("home");
}

function resetState() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.ws = null;
  state.playerId = null;
  state.room = null;
  state.endsAt = null;
  state.myScore = 0;
  state.oppScore = 0;
  state.oppName = "상대";
  $("hudMe").querySelector(".score").textContent = "0";
  $("hudOpp").querySelector(".score").textContent = "0";
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

  ws.addEventListener("msg:queued", (e) => {
    $("lobbyMsg").textContent = `매칭 대기열 ${e.detail.position}번째…`;
  });

  ws.addEventListener("msg:not_found", () => {
    alert("방을 찾을 수 없습니다.");
    leaveAndGoHome();
  });

  ws.addEventListener("msg:room_full", () => {
    alert("방이 가득 찼거나 이미 게임 중입니다.");
    leaveAndGoHome();
  });

  ws.addEventListener("msg:game_start", (e) => {
    const m = e.detail;
    state.endsAt = m.ends_at * 1000;
    state.myScore = 0;
    state.oppScore = 0;
    state.renderer.setBoard(m.board);
    state.renderer.setPeerDrag(null);
    updateHud();
    show("game");
    startTimer();
    // resize after layout settles
    requestAnimationFrame(() => state.renderer.resize());
  });

  ws.addEventListener("msg:peer_drag", (e) => {
    const { player_id, r1, c1, r2, c2 } = e.detail;
    if (player_id === state.playerId) return;
    state.renderer.setPeerDrag({ r1, c1, r2, c2 });
  });

  ws.addEventListener("msg:clear", (e) => {
    const { cells, scores, player_id } = e.detail;
    state.renderer.clearCells(cells);
    if (player_id !== state.playerId) state.renderer.setPeerDrag(null);
    applyScores(scores);
  });

  ws.addEventListener("msg:reject", () => {
    // Optional: brief shake or sound; for now just clear sum badge
  });

  ws.addEventListener("msg:game_end", (e) => {
    showResult(e.detail);
  });

  ws.addEventListener("msg:error", (e) => {
    console.warn("server error:", e.detail);
  });
}

function onRoomUpdate(room) {
  state.room = { ...room, players: [...room.players] };
  state.hostId = room.host_id;
  state.mode = room.mode;
  $("roomCode").textContent = room.id;
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
  // Show start button only for host in friend mode when both players present
  const isHost = state.playerId === state.hostId;
  const canStart = state.mode === "friend" && isHost && state.room.players.length === 2;
  $("startBtn").hidden = !canStart;
  if (state.mode === "friend") {
    $("lobbyMsg").textContent =
      state.room.players.length === 2
        ? (isHost ? "준비되면 시작 버튼을 누르세요." : "방장이 시작하기를 기다리는 중…")
        : "친구에게 코드를 공유하세요.";
  }
}

function applyScores(scores) {
  for (const [pid, s] of Object.entries(scores)) {
    if (pid === state.playerId) state.myScore = s;
    else {
      state.oppScore = s;
      // capture opp name
      const opp = state.room?.players.find((p) => p.id === pid);
      if (opp) state.oppName = opp.nickname;
    }
  }
  updateHud();
}

function updateHud() {
  $("hudMe").querySelector(".name").textContent = state.myName;
  $("hudOpp").querySelector(".name").textContent = state.oppName;
  $("hudMe").querySelector(".score").textContent = String(state.myScore);
  $("hudOpp").querySelector(".score").textContent = String(state.oppScore);
}

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

function showResult(detail) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;

  const { scores, winner_id } = detail;
  const list = $("finalScores");
  list.innerHTML = "";
  const players = state.room?.players ?? [];
  // Order: me first
  const ordered = players.slice().sort((a, b) => (a.id === state.playerId ? -1 : b.id === state.playerId ? 1 : 0));
  for (const p of ordered) {
    const li = document.createElement("li");
    if (p.id === winner_id) li.classList.add("winner");
    const meLabel = p.id === state.playerId ? " (나)" : "";
    const score = scores[p.id] ?? 0;
    li.innerHTML = `<span>${escapeHtml(p.nickname)}${meLabel}</span><strong>${score}</strong>`;
    list.appendChild(li);
  }
  let title = "결과";
  if (winner_id === null || winner_id === undefined) title = "무승부 🤝";
  else if (winner_id === state.playerId) title = "승리! 🎉";
  else title = "패배 😢";
  // Solo: just show score
  if (state.mode === "solo") {
    title = `점수: ${state.myScore} / 170`;
  }
  $("resultTitle").textContent = title;

  // Rematch only when room still exists with both players (friend / random)
  const both = players.length === 2;
  $("rematchBtn").hidden = !(both && (state.mode === "friend" ? state.playerId === state.hostId : true));
  show("result");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
