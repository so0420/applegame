"""Block requests from known datacenter / VPN ranges.

Loads a CIDR list at import time and exposes:
- ``is_blocked_ip(ip)`` for ad-hoc checks (WebSocket upgrade path)
- ``AntiVPNMiddleware`` that returns 403 for HTTP requests from blocked IPs

The CIDR list is intentionally a curated subset; deployment owners are
expected to extend ``app/data/blocked_cidrs.txt`` over time.
"""
from __future__ import annotations

import ipaddress
import logging
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse

log = logging.getLogger(__name__)

_CIDR_FILE = Path(__file__).resolve().parent / "data" / "blocked_cidrs.txt"


def _load_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    try:
        for raw in _CIDR_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            try:
                nets.append(ipaddress.ip_network(line, strict=False))
            except ValueError:
                log.warning("anti-vpn: bad CIDR %r in %s", line, _CIDR_FILE)
    except FileNotFoundError:
        log.warning("anti-vpn: %s missing; no IPs blocked", _CIDR_FILE)
    return nets


_BLOCKED_NETWORKS = _load_networks()


def _client_ip(request_headers: dict, fallback: str | None) -> str | None:
    """Best-effort client IP. Honours X-Forwarded-For when present so a
    reverse proxy doesn't mask the real peer."""
    xff = request_headers.get("x-forwarded-for") or request_headers.get("X-Forwarded-For")
    if xff:
        # First in the chain is the original client.
        return xff.split(",")[0].strip()
    real = request_headers.get("x-real-ip") or request_headers.get("X-Real-IP")
    if real:
        return real.strip()
    return fallback


def is_blocked_ip(ip: str | None) -> bool:
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # Always allow loopback / private / link-local. Useful for dev and
    # for users on the same LAN.
    if addr.is_loopback or addr.is_private or addr.is_link_local:
        return False
    return any(addr in net for net in _BLOCKED_NETWORKS)


def client_ip_from_request(request: Request) -> str | None:
    return _client_ip(dict(request.headers), request.client.host if request.client else None)


class AntiVPNMiddleware(BaseHTTPMiddleware):
    """Rejects HTTP requests from blocked CIDR ranges with a 403."""

    async def dispatch(self, request: Request, call_next):  # noqa: D401
        ip = client_ip_from_request(request)
        if is_blocked_ip(ip):
            log.info("anti-vpn block ip=%s path=%s", ip, request.url.path)
            return PlainTextResponse(
                "이 네트워크(데이터센터/VPN)에서는 접속할 수 없습니다.",
                status_code=403,
            )
        return await call_next(request)
