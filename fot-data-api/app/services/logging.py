"""Best-effort логирование запросов в data_api_request_logs."""

from __future__ import annotations

import json
from typing import Any

from app.lib.postgres import execute


async def write_log(
    *,
    key_id: str | None,
    table_name: str | None,
    ip: str | None,
    status_code: int,
    latency_ms: int,
    query_params: dict[str, Any] | None,
    error_message: str | None = None,
) -> None:
    try:
        await execute(
            """
            INSERT INTO data_api_request_logs
                (key_id, table_name, ip, status_code, latency_ms, query_params, error_message)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
            """,
            (
                key_id,
                table_name,
                ip,
                status_code,
                latency_ms,
                json.dumps(query_params) if query_params is not None else None,
                error_message,
            ),
        )
    except Exception:  # noqa: BLE001
        # Логирование не должно ломать основной запрос.
        pass
