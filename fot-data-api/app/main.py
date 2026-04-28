"""FastAPI-сервис для read-only Data API.

Работает на отдельном порту (по умолчанию 4001), запросы клиентов поступают
через nginx-proxy на префиксе ``/external/v1/*``. Аутентификация — Bearer-токен,
выданный из админ-вкладки FOT (Express + React UI).
"""

from __future__ import annotations

import time
from typing import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import get_settings
from app.routers import health, tables
from app.services.logging import write_log

settings = get_settings()


def _rate_limit_key(request: Request) -> str:
    """Ключ rate-limit'а — id API-ключа, проставленный в authenticate()."""
    api_key = getattr(request.state, "api_key", None)
    if api_key is not None:
        return f"key:{api_key.id}"
    # До аутентификации — лимитим по IP, чтобы защититься от brute force.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return f"ip:{forwarded.split(',')[0].strip()}"
    return f"ip:{request.client.host if request.client else 'unknown'}"


def _dynamic_limit(request: Request) -> str:
    api_key = getattr(request.state, "api_key", None)
    if api_key is not None and api_key.rate_limit_per_minute > 0:
        return f"{api_key.rate_limit_per_minute}/minute"
    return f"{settings.DEFAULT_RATE_LIMIT_PER_MINUTE}/minute"


limiter = Limiter(key_func=_rate_limit_key, default_limits=[])

app = FastAPI(
    title="FOT Public Data API",
    version="1.0.0",
    description="Read-only доступ к данным БД по API-ключу.",
    docs_url="/external/v1/docs",
    openapi_url="/external/v1/openapi.json",
    redoc_url=None,
)
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )


@app.middleware("http")
async def access_log_and_limit(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """Логирование каждого запроса в data_api_request_logs.

    Динамический rate limit применяется через ``slowapi`` после аутентификации.
    Здесь мы просто измеряем latency и пишем строку лога.
    """
    started = time.perf_counter()
    response: Response | None = None
    error: str | None = None
    try:
        response = await call_next(request)
        return response
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        raise
    finally:
        if request.url.path.startswith("/external/v1") and not request.url.path.endswith("/health"):
            api_key = getattr(request.state, "api_key", None)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            status_code = response.status_code if response is not None else 500
            write_log(
                key_id=api_key.id if api_key else None,
                table_name=request.path_params.get("table_name") if hasattr(request, "path_params") else None,
                ip=request.client.host if request.client else None,
                status_code=status_code,
                latency_ms=elapsed_ms,
                query_params=dict(request.query_params) or None,
                error_message=error,
            )


# Применяем динамический лимит ко всем маршрутам tables.py.
# slowapi требует, чтобы limit передавался при подключении — поэтому
# навешиваем его декоратором через limiter.shared_limit.
shared = limiter.shared_limit(_dynamic_limit, scope="external-tables")
for route in tables.router.routes:
    if hasattr(route, "endpoint"):
        route.endpoint = shared(route.endpoint)  # type: ignore[attr-defined]

app.include_router(health.router)
app.include_router(tables.router)
