"""FastAPI application entry point."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .matchmaking import Matchmaker
from .ws.handlers import session
from .ws.manager import RoomManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="Multi Apple Game",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

manager = RoomManager()
matchmaker = Matchmaker(manager)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await session(websocket, manager, matchmaker)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
