"""Run the Multi Apple Game server directly: `python applegame.py`."""
import socket

import uvicorn

from app.main import app


def _local_ips() -> list[str]:
    ips: list[str] = []
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None):
            ip = info[4][0]
            if "." in ip and ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips


if __name__ == "__main__":
    port = 8000
    print(f"  local:    http://127.0.0.1:{port}", flush=True)
    for ip in _local_ips():
        print(f"  network:  http://{ip}:{port}", flush=True)
    # Bind to 0.0.0.0 so other devices on the LAN can connect.
    # Disable uvicorn's WebSocket keepalive pings — Chromium throttles
    # background tabs aggressively and the default 20s pong timeout
    # would drop connections whenever a player Alt-Tabs away.
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
