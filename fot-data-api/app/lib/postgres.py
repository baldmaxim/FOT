"""Async-пул psycopg3 для FastAPI-сервиса.

Открывается лениво при первом обращении. SSL включается из конфига
(DATABASE_SSL/DATABASE_SSL_CA_PATH). На shutdown FastAPI вызывает
:func:`close_pool` через lifespan, чтобы корректно вернуть коннекты
драйверу до остановки event loop.

Все хелперы — ``async def``: handler'ы и middleware FastAPI работают в
event loop, и синхронный psycopg внутри ``async def`` блокировал бы loop
на время каждого SELECT/INSERT (и под нагрузкой это душит остальные
запросы). С AsyncConnectionPool каждый запрос — fully cooperative.
"""

from __future__ import annotations

import asyncio
from typing import Any, Sequence

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings

_pool: AsyncConnectionPool | None = None
_pool_init_lock = asyncio.Lock()


def _build_kwargs() -> dict[str, Any]:
    """Доп. libpq-параметры; имеют приоритет над DATABASE_URL.

    DATABASE_SSL=false   → sslmode=disable (только для локального dev).
    DATABASE_SSL_CA_PATH → sslmode=verify-full + sslrootcert (рекомендуется
                           для Yandex Managed PG: CA берётся в консоли).
    иначе                → sslmode=require (шифрование без верификации CA).
    """
    settings = get_settings()
    kwargs: dict[str, Any] = {}
    if not settings.DATABASE_SSL:
        kwargs["sslmode"] = "disable"
    elif settings.DATABASE_SSL_CA_PATH:
        kwargs["sslmode"] = "verify-full"
        kwargs["sslrootcert"] = settings.DATABASE_SSL_CA_PATH
    else:
        kwargs["sslmode"] = "require"
    return kwargs


async def get_pool() -> AsyncConnectionPool:
    """Lazy singleton AsyncConnectionPool. Открывается при первом await."""
    global _pool
    if _pool is not None:
        return _pool
    async with _pool_init_lock:
        if _pool is not None:
            return _pool
        settings = get_settings()
        pool = AsyncConnectionPool(
            conninfo=settings.DATABASE_URL,
            kwargs=_build_kwargs(),
            min_size=1,
            max_size=10,
            timeout=10.0,
            open=False,  # async pools открываем явно через await
        )
        await pool.open()
        _pool = pool
    return _pool


async def close_pool() -> None:
    """Закрывает пул. Идемпотентно. Вызывается из FastAPI lifespan."""
    global _pool
    if _pool is None:
        return
    p = _pool
    _pool = None
    await p.close()


async def fetch_one(
    query: sql.SQL | sql.Composed | str,
    params: Sequence[Any] | None = None,
) -> dict[str, Any] | None:
    pool = await get_pool()
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(query, params or ())
            return await cur.fetchone()


async def fetch_all(
    query: sql.SQL | sql.Composed | str,
    params: Sequence[Any] | None = None,
) -> list[dict[str, Any]]:
    pool = await get_pool()
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(query, params or ())
            return await cur.fetchall()


async def execute(
    query: sql.SQL | sql.Composed | str,
    params: Sequence[Any] | None = None,
) -> int:
    """Выполняет запрос без возврата строк. Возвращает rowcount."""
    pool = await get_pool()
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(query, params or ())
            return cur.rowcount
