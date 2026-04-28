"""Аутентификация по API-ключу.

Формат токена: ``fot_<16-hex-prefix>_<48-hex-secret>``. Префикс — public id
для быстрого lookup, секрет проверяется по sha256(secret) в постоянном времени.
Идентичная схема используется в Express-сервисе при создании ключа.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime, timezone

from fastapi import HTTPException, Request, status

from app.lib.supabase import get_supabase
from app.models import ApiKey

_TOKEN_RE = re.compile(r"^fot_([0-9a-f]{16})_([0-9a-f]{48})$")


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    # supabase возвращает '2026-04-28T10:00:00+00:00'
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _extract_bearer(request: Request) -> str:
    header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")
    parts = header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Authorization header")
    return parts[1].strip()


async def authenticate(request: Request) -> ApiKey:
    """FastAPI-зависимость: проверяет Bearer-токен и возвращает объект ключа.

    Кладёт результат в request.state.api_key, чтобы middleware логирования и
    rate limiter могли его прочитать без повторного запроса в БД.
    """
    token = _extract_bearer(request)
    match = _TOKEN_RE.match(token)
    if not match:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token format")
    prefix, secret = match.group(1), match.group(2)

    supabase = get_supabase()
    result = (
        supabase.table("data_api_keys")
        .select("id, name, key_hash, rate_limit_per_minute, expires_at, revoked_at")
        .eq("key_prefix", prefix)
        .maybe_single()
        .execute()
    )
    row = result.data if result and result.data else None
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    expected = row.get("key_hash") or ""
    if not hmac.compare_digest(expected, _sha256_hex(secret)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    revoked_at = _parse_iso(row.get("revoked_at"))
    if revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    expires_at = _parse_iso(row.get("expires_at"))
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")

    api_key = ApiKey(
        id=row["id"],
        name=row.get("name") or "",
        rate_limit_per_minute=int(row.get("rate_limit_per_minute") or 60),
        revoked_at=revoked_at,
        expires_at=expires_at,
    )
    request.state.api_key = api_key

    # Обновляем last_used_at — best-effort, ошибки игнорируем.
    try:
        supabase.table("data_api_keys").update(
            {"last_used_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", api_key.id).execute()
    except Exception:  # noqa: BLE001
        pass

    return api_key
