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
    port = 9000
    print(f"  local:    http://127.0.0.1:{port}", flush=True)
    for ip in _local_ips():
        print(f"  network:  http://{ip}:{port}", flush=True)
    # Bind to 0.0.0.0 so other devices on the LAN can connect.
    # WebSocket keepalive: pings every 30 s keep idle proxies/NATs from
    # dropping the connection (most cloud edges idle out at ~60 s), and a
    # 120 s pong timeout is long enough for Chromium's aggressive
    # background-tab throttling to still respond before the server gives
    # up. The client also sends its own heartbeat as a belt-and-braces.
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        ws_ping_interval=30,
        ws_ping_timeout=120,
    )
