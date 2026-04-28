"""Best-effort логирование запросов в data_api_request_logs."""

from __future__ import annotations

from typing import Any

from app.lib.supabase import get_supabase


def write_log(
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
        get_supabase().table("data_api_request_logs").insert(
            {
                "key_id": key_id,
                "table_name": table_name,
                "ip": ip,
                "status_code": status_code,
                "latency_ms": latency_ms,
                "query_params": query_params,
                "error_message": error_message,
            }
        ).execute()
    except Exception:  # noqa: BLE001
        # Логирование не должно ломать основной запрос.
        pass
