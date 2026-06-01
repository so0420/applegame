"""문의(피드백) → 디스코드 알림.

저장소(DB) 없이 디스코드 웹훅으로만 전달한다. 전송이 성공해야 접수로
간주하므로(엔드포인트가 await), 디스코드가 죽었거나 URL 미설정이면 사용자에게
'전송 실패'가 그대로 보인다 — 조용한 유실이 없다.

웹훅 URL 은 환경변수 ``DISCORD_WEBHOOK_URL`` 에서 읽는다 (.env 에 보관,
깃에는 안 올라감).
"""
from __future__ import annotations

import logging
import os
import time

log = logging.getLogger(__name__)

# 입력 제한 — 폼 스팸/남용 방지.
MAX_MESSAGE_LEN = 2000
MAX_CONTACT_LEN = 200
MIN_MESSAGE_LEN = 2

# 간단한 인메모리 IP 레이트리밋 (프로세스 단위). 영속 X — 재시작 시 리셋.
_RATE_WINDOW_S = 3600.0   # 1시간
_RATE_MAX = 8             # IP당 시간당 최대 8건
_ip_hits: dict[str, list[float]] = {}


def rate_limited(ip: str | None, now: float | None = None) -> bool:
    """True 면 이 IP 는 당분간 더 못 보냄. 윈도우 밖 기록은 청소한다."""
    if not ip:
        return False
    now = time.time() if now is None else now
    hits = [t for t in _ip_hits.get(ip, []) if now - t < _RATE_WINDOW_S]
    _ip_hits[ip] = hits
    return len(hits) >= _RATE_MAX


def _record_hit(ip: str | None, now: float | None = None) -> None:
    if not ip:
        return
    now = time.time() if now is None else now
    _ip_hits.setdefault(ip, []).append(now)


async def submit_feedback(
    message: str, contact: str | None, ip: str | None,
) -> bool:
    """디스코드로 문의를 전달. 성공하면 True.

    URL 미설정이거나 전송 실패면 False — 호출부(엔드포인트)가 사용자에게
    실패를 알린다. 유효한 시도마다 레이트리밋 기록을 남긴다."""
    _record_hit(ip)
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        log.warning("feedback received but DISCORD_WEBHOOK_URL is unset; not delivered")
        return False
    return await _post_to_discord(url, message, contact, ip)


async def _post_to_discord(
    url: str, message: str, contact: str | None, ip: str | None,
) -> bool:
    # 디스코드 메시지 길이 한도(2000) 안에서 안전하게 자른다.
    body_lines = [
        "**🍎 새 문의**",
        f"> {message[:1500].replace(chr(10), chr(10) + '> ')}",
    ]
    if contact:
        body_lines.append(f"연락처: `{contact[:MAX_CONTACT_LEN]}`")
    if ip:
        body_lines.append(f"IP: `{ip}`")
    # allowed_mentions={parse:[]} — user-supplied text containing @everyone /
    # @here / role mentions must NOT ping the channel.
    payload = {
        "content": "\n".join(body_lines)[:1990],
        "allowed_mentions": {"parse": []},
    }
    try:
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            log.warning(
                "discord webhook non-2xx: %s %s",
                resp.status_code, resp.text[:200],
            )
            return False
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("discord webhook failed: %s", e)
        return False
