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

from app.lib.postgres import execute, fetch_one
from app.models import ApiKey

_TOKEN_RE = re.compile(r"^fot_([0-9a-f]{16})_([0-9a-f]{48})$")


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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

    row = await fetch_one(
        """
        SELECT id, name, key_hash, rate_limit_per_minute, expires_at, revoked_at
          FROM data_api_keys
         WHERE key_prefix = %s
         LIMIT 1
        """,
        (prefix,),
    )
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    expected = row.get("key_hash") or ""
    if not hmac.compare_digest(expected, _sha256_hex(secret)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    revoked_at = row.get("revoked_at")
    if revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    expires_at = row.get("expires_at")
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")

    api_key = ApiKey(
        id=str(row["id"]),
        name=row.get("name") or "",
        rate_limit_per_minute=int(row.get("rate_limit_per_minute") or 60),
        revoked_at=revoked_at,
        expires_at=expires_at,
    )
    request.state.api_key = api_key

    # Обновляем last_used_at — best-effort, ошибки игнорируем.
    try:
        await execute(
            "UPDATE data_api_keys SET last_used_at = now() WHERE id = %s",
            (api_key.id,),
        )
    except Exception:  # noqa: BLE001
        pass

    return api_key
