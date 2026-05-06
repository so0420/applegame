"""Run the Multi Apple Game server directly: `python applegame.py`."""
import uvicorn

from app.main import app


if __name__ == "__main__":
    # Disable uvicorn's WebSocket keepalive pings.
    # Chromium throttles background tabs aggressively, so pong responses
    # for the default 20s timeout often arrive late when a player Alt-Tabs
    # to another window, and the server then drops the connection. The TCP
    # layer keeps the socket alive on its own, which is good enough for a
    # 2-minute game session.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
