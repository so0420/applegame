"""FastAPI application entry point."""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

# .env 자동 로드 — 다른 모듈이 os.environ.get() 으로 값을 읽기 전에
# 먼저 끌어와야 한다. python-dotenv 가 설치 안 되어 있어도 (개발 환경
# 일부) 앱이 죽지 않도록 import 실패는 조용히 넘긴다 — 그땐 환경변수
# 그대로 사용.
try:
    from dotenv import load_dotenv
    _DOTENV_PATH = Path(__file__).resolve().parent.parent / ".env"
    if _DOTENV_PATH.is_file():
        load_dotenv(_DOTENV_PATH)
except ImportError:
    pass

import asyncio

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .anti_vpn import AntiVPNMiddleware, _client_ip, is_blocked_ip
from .matchmaking import Matchmaker
from .ws.handlers import _start_game, session
from .ws.manager import RoomManager, broadcast

# Monitoring 인증: 환경변수에 토큰을 박아두면 ?token=... 일치 시에만 통과.
# 토큰 미설정 시 외부 IP는 404 (엔드포인트 자체를 숨김), 로컬만 허용.
MONITORING_TOKEN = os.environ.get("MONITORING_TOKEN")
# 1초마다 push — DOM diff 안 하고 통째 갱신해도 깜빡임 없는 정도.
MONITORING_PUSH_INTERVAL = 1.0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="Multi Apple Game",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class NoCacheMiddleware(BaseHTTPMiddleware):
    """Disable browser caching for HTML/CSS/JS during development, and
    stamp anti-indexing / no-AI-training headers on every response.

    The header acts as a belt-and-braces around robots.txt for crawlers
    that ignore robots.txt but honour X-Robots-Tag (Google, Bing, and
    several AI crawlers explicitly do).
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        response.headers["X-Robots-Tag"] = (
            "noindex, nofollow, noarchive, nosnippet, noai, noimageai"
        )
        return response


app.add_middleware(NoCacheMiddleware)
app.add_middleware(AntiVPNMiddleware)

manager = RoomManager()
matchmaker = Matchmaker(manager, on_start=_start_game, broadcast=broadcast)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/robots.txt")
async def robots() -> FileResponse:
    # Disallow every crawler — game is real-time, no content to index.
    # AI training bots get explicit User-agent entries inside the file.
    return FileResponse(STATIC_DIR / "robots.txt", media_type="text/plain")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _check_monitoring_auth(
    token: str, client_host: str, has_forwarded_header: bool,
) -> bool:
    """공통 인증. HTTP/WS 양쪽에서 동일 정책으로 검사한다."""
    if MONITORING_TOKEN:
        return token == MONITORING_TOKEN
    # 토큰 미설정 모드 = "로컬만 허용" 의도. 프록시 헤더가 보이면
    # 이미 외부 경유라 가정하고 거부.
    if has_forwarded_header:
        return False
    return client_host in ("127.0.0.1", "::1")


def _monitoring_snapshot() -> dict[str, object]:
    """방 상태 스냅샷. WS push 와 (옵션) JSON 폴백에서 같이 쓴다."""
    now = time.time()
    rooms = list(manager.rooms.values())
    state_order = {"playing": 0, "waiting": 1, "finished": 2}
    rooms.sort(key=lambda r: (
        state_order.get(r.state, 99),
        r.ends_at if r.ends_at else float("inf"),
    ))

    rooms_data: list[dict[str, object]] = []
    for r in rooms:
        host = r.players.get(r.host_id) if r.host_id else None
        rooms_data.append({
            "id": r.id,
            "mode": r.mode,
            "variant": r.variant,
            "state": r.state,
            "player_count": len(r.players),
            "capacity": r.capacity,
            "ends_at": r.ends_at,
            "started_at": r.started_at,
            "host_nickname": host.nickname if host else None,
            "players": [
                {
                    "nickname": p.nickname,
                    "score": p.score,
                    "connected": p.connected,
                    "is_host": p.id == r.host_id,
                }
                for p in r.players.values()
            ],
        })

    total = len(rooms)
    playing = sum(1 for r in rooms if r.state == "playing")
    waiting = sum(1 for r in rooms if r.state == "waiting")
    finished = sum(1 for r in rooms if r.state == "finished")
    total_players = sum(len(r.players) for r in rooms)
    connected_players = sum(
        sum(1 for p in r.players.values() if p.connected) for r in rooms
    )

    return {
        "ts": now,
        "stats": {
            "total": total,
            "playing": playing,
            "waiting": waiting,
            "finished": finished,
            "connected_players": connected_players,
            "total_players": total_players,
        },
        "rooms": rooms_data,
    }


_MONITORING_HTML = """<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Monitoring</title>
<style>
  body { font: 13px/1.5 -apple-system, "Segoe UI", monospace; background: #0f1115; color: #e8eaed; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 6px 0; }
  .timestamp { color: #8a8f98; font-size: 12px; margin-bottom: 18px; }
  .timestamp .conn { padding: 2px 8px; border-radius: 4px; margin-left: 6px; font-size: 11px; }
  .timestamp .conn.live { background: #1e4d2a; color: #66bb6a; }
  .timestamp .conn.dead { background: #4d1e1e; color: #ff8a80; }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat { background: #1a1d24; border: 1px solid #2a2e36; border-radius: 8px; padding: 10px 16px; min-width: 110px; }
  .stat .label { color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 22px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .stat.playing .value { color: #66bb6a; }
  .stat.waiting .value { color: #ffb74d; }
  .stat.finished .value { color: #8a8f98; }
  table { width: 100%; border-collapse: collapse; background: #1a1d24; border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #2a2e36; vertical-align: top; }
  th { background: #15171c; color: #8a8f98; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr.state-playing td:nth-child(4) { color: #66bb6a; font-weight: 600; }
  tr.state-waiting td:nth-child(4) { color: #ffb74d; font-weight: 600; }
  tr.state-finished td:nth-child(4) { color: #8a8f98; }
  .mono { font-family: "SF Mono", Consolas, monospace; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .muted { color: #8a8f98; }
  .empty { padding: 30px; text-align: center; color: #8a8f98; background: #1a1d24; border-radius: 8px; }
  .hint { color: #8a8f98; font-size: 12px; margin-top: 18px; }
</style>
</head><body>
<h1>🍎 Multi Apple Game · Monitoring</h1>
<div class="timestamp">
  <span id="ts">connecting…</span>
  <span id="conn" class="conn dead">disconnected</span>
</div>
<div class="stats">
  <div class="stat"><div class="label">Total rooms</div><div class="value" id="stat-total">—</div></div>
  <div class="stat playing"><div class="label">Playing</div><div class="value" id="stat-playing">—</div></div>
  <div class="stat waiting"><div class="label">Waiting</div><div class="value" id="stat-waiting">—</div></div>
  <div class="stat finished"><div class="label">Finished</div><div class="value" id="stat-finished">—</div></div>
  <div class="stat"><div class="label">Players</div><div class="value" id="stat-players">—</div></div>
</div>
<div id="rooms-container">
  <div class="empty">Loading…</div>
</div>
<p class="hint">재시작 안내: <strong>Playing</strong>가 0 이거나 <strong>Time left</strong>가 모두 거의 끝났을 때가 가장 안전합니다. WS는 재시작 시 모두 끊기며 자동 재접속은 30분 이내에만 시도됩니다.</p>
<script>
(function() {
  const TOKEN_QS = __TOKEN_QS__;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/monitoring/ws${TOKEN_QS}`;
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[m]));
  }
  function fmtMmss(sec) {
    if (sec == null || sec < 0) return "—";
    const s = Math.floor(sec);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
  }
  function fmtHms(epoch) {
    if (!epoch) return "—";
    const d = new Date(epoch * 1000);
    return d.toTimeString().slice(0, 8);
  }
  function render(data) {
    const now = data.ts;
    const s = data.stats;
    $("ts").textContent = new Date(now * 1000).toISOString().replace("T", " ").slice(0, 19);
    $("stat-total").textContent = s.total;
    $("stat-playing").textContent = s.playing;
    $("stat-waiting").textContent = s.waiting;
    $("stat-finished").textContent = s.finished;
    $("stat-players").textContent = `${s.connected_players}/${s.total_players}`;

    const container = $("rooms-container");
    if (!data.rooms.length) {
      container.innerHTML = '<div class="empty">No active rooms.</div>';
      return;
    }
    let html = '<table><thead><tr>'
      + '<th>Room</th><th>Mode</th><th>Variant</th><th>State</th>'
      + '<th>Players</th><th>Time left</th><th>Started</th><th>Host</th><th>In room</th>'
      + '</tr></thead><tbody>';
    for (const r of data.rooms) {
      let remaining;
      if (r.state === "playing" && r.ends_at) remaining = fmtMmss(r.ends_at - now);
      else if (r.state === "waiting") remaining = "—";
      else remaining = "ended";

      const playersHtml = r.players.length
        ? r.players.map((p) => {
            const mark = p.is_host ? " 👑" : "";
            const tag = p.connected ? "" : " ⏸";
            return `${esc(p.nickname)}${mark}${tag} <span class="muted">(${p.score})</span>`;
          }).join(", ")
        : '<span class="muted">(none)</span>';

      html += `<tr class="state-${esc(r.state)}">`
        + `<td class="mono">${esc(r.id)}</td>`
        + `<td>${esc(r.mode)}</td>`
        + `<td>${esc(r.variant)}</td>`
        + `<td>${esc(r.state)}</td>`
        + `<td class="num">${r.player_count}/${r.capacity}</td>`
        + `<td>${esc(remaining)}</td>`
        + `<td>${esc(fmtHms(r.started_at))}</td>`
        + `<td>${esc(r.host_nickname || "—")}</td>`
        + `<td>${playersHtml}</td>`
        + "</tr>";
    }
    html += "</tbody></table>";
    container.innerHTML = html;
  }
  function setConn(live) {
    const el = $("conn");
    el.textContent = live ? "live" : "disconnected · retrying";
    el.className = "conn " + (live ? "live" : "dead");
  }
  let ws;
  let retryTimer;
  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws.onopen = () => setConn(true);
    ws.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = () => { setConn(false); scheduleRetry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 2000);
  }
  connect();
})();
</script>
</body></html>
"""


@app.get("/monitoring", response_model=None)
async def monitoring(request: Request) -> HTMLResponse | PlainTextResponse:
    """Operator dashboard — room list + counts. Live-updated via WebSocket
    (/monitoring/ws). Used to decide whether it's safe to restart the
    server (e.g. wait until no 'playing' rooms have time left).

    Auth failure returns 404 so the endpoint is indistinguishable from a
    missing route. Use MONITORING_TOKEN env var to enable remote access.
    """
    token = request.query_params.get("token") or ""
    client = request.client.host if request.client else ""
    has_xff = "x-forwarded-for" in request.headers or "x-real-ip" in request.headers
    if not _check_monitoring_auth(token, client, has_xff):
        return PlainTextResponse("Not Found", status_code=404)

    # 클라가 WS 연결할 때 토큰을 다시 붙여야 함. JSON 인코딩으로 따옴표
    # escape — script 안에 안전하게 박힘.
    token_qs_value = f"?token={MONITORING_TOKEN}" if MONITORING_TOKEN else ""
    body = _MONITORING_HTML.replace("__TOKEN_QS__", json.dumps(token_qs_value))
    return HTMLResponse(body)


@app.websocket("/monitoring/ws")
async def monitoring_ws(websocket: WebSocket) -> None:
    """Live push of monitoring snapshots — 1 per second while open."""
    token = websocket.query_params.get("token") or ""
    client = websocket.client.host if websocket.client else ""
    headers = {k.decode().lower() for k, _ in websocket.headers.raw}
    has_xff = "x-forwarded-for" in headers or "x-real-ip" in headers
    if not _check_monitoring_auth(token, client, has_xff):
        # 인증 실패 — 그냥 닫음. 404 HTTP 와 동일하게 "엔드포인트 자체가
        # 없는 것처럼" 보이려면 accept 도 안 하고 close.
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(_monitoring_snapshot())
            await asyncio.sleep(MONITORING_PUSH_INTERVAL)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("monitoring ws error")
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    # HTTP middlewares aren't invoked for WebSocket upgrades, so the
    # VPN/datacenter check has to run here too.
    headers = {k.decode().lower(): v.decode() for k, v in websocket.headers.raw}
    client_host = websocket.client.host if websocket.client else None
    if is_blocked_ip(_client_ip(headers, client_host)):
        await websocket.close(code=1008, reason="blocked_network")
        return
    await session(websocket, manager, matchmaker)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
