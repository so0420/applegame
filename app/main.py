"""FastAPI application entry point."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .anti_vpn import AntiVPNMiddleware, _client_ip, is_blocked_ip
from .matchmaking import Matchmaker
from .ws.handlers import _start_game, session
from .ws.manager import RoomManager, broadcast

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="Multi Apple Game",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class NoCacheMiddleware(BaseHTTPMiddleware):
    """Disable browser caching for HTML/CSS/JS during development."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app.add_middleware(NoCacheMiddleware)
app.add_middleware(AntiVPNMiddleware)

manager = RoomManager()
matchmaker = Matchmaker(manager, on_start=_start_game, broadcast=broadcast)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


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
