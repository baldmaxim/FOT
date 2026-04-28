"""Построение безопасных SELECT-запросов через supabase-py.

Все имена таблиц и колонок проверяются по whitelist `data_api_key_tables`
(см. ``get_table_access``). Никакого raw SQL, только цепочка builder-методов
PostgREST. Параметры фильтрации разбираются вручную из query string,
чтобы поддерживались только разрешённые операторы.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from supabase import Client

from app.lib.supabase import get_supabase

# Поддерживаемые префиксы query-параметров: значение проверяется по полю,
# которое явно перечислено в allowed_fields ключа.
_FILTER_OPERATORS = {"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"}
_RESERVED_PARAMS = {"limit", "offset", "order"}

MAX_LIMIT = 1000
DEFAULT_LIMIT = 100


def get_table_access(api_key_id: str, table_name: str) -> list[str] | None:
    """Возвращает список allowed_fields для пары ключ/таблица или None."""
    supabase = get_supabase()
    result = (
        supabase.table("data_api_key_tables")
        .select("allowed_fields")
        .eq("key_id", api_key_id)
        .eq("table_name", table_name)
        .maybe_single()
        .execute()
    )
    if not result or not result.data:
        return None
    fields = result.data.get("allowed_fields") or []
    return list(fields) if fields else None


def list_accessible_tables(api_key_id: str) -> list[dict[str, Any]]:
    supabase = get_supabase()
    result = (
        supabase.table("data_api_key_tables")
        .select("table_name, allowed_fields")
        .eq("key_id", api_key_id)
        .order("table_name")
        .execute()
    )
    return list(result.data or [])


def parse_pagination(query: dict[str, str]) -> tuple[int, int]:
    try:
        limit = int(query.get("limit", DEFAULT_LIMIT))
        offset = int(query.get("offset", 0))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="limit/offset must be integers") from exc
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"limit must be between 1 and {MAX_LIMIT}")
    if offset < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="offset must be >= 0")
    return limit, offset


def _split_op(key: str) -> tuple[str, str] | None:
    """Возвращает (operator, column) для ключа вида 'eq.column'."""
    if "." not in key:
        return None
    op, _, column = key.partition(".")
    if op not in _FILTER_OPERATORS:
        return None
    if not column:
        return None
    return op, column


def _ensure_allowed(field: str, allowed: set[str], context: str) -> None:
    if field not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Field '{field}' is not allowed in {context}",
        )


def _apply_filter(builder, op: str, column: str, value: str):
    if op == "eq":
        return builder.eq(column, value)
    if op == "neq":
        return builder.neq(column, value)
    if op == "gt":
        return builder.gt(column, value)
    if op == "gte":
        return builder.gte(column, value)
    if op == "lt":
        return builder.lt(column, value)
    if op == "lte":
        return builder.lte(column, value)
    if op == "like":
        return builder.like(column, value)
    if op == "ilike":
        return builder.ilike(column, value)
    if op == "in":
        values = [v for v in value.split(",") if v]
        if not values:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"in.{column} requires at least one value")
        return builder.in_(column, values)
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported operator '{op}'")


def execute_select(
    table_name: str,
    allowed_fields: list[str],
    query: dict[str, str],
) -> tuple[list[dict[str, Any]], int, int]:
    if not allowed_fields:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No fields allowed for this table")
    allowed_set = set(allowed_fields)

    supabase: Client = get_supabase()
    builder = supabase.table(table_name).select(",".join(allowed_fields))

    for raw_key, raw_value in query.items():
        if raw_key in _RESERVED_PARAMS:
            continue
        parsed = _split_op(raw_key)
        if parsed is None:
            # Неизвестный параметр — игнорируем, чтобы клиент мог передавать
            # служебные query-параметры (например, для кеширования).
            continue
        op, column = parsed
        _ensure_allowed(column, allowed_set, "filter")
        builder = _apply_filter(builder, op, column, raw_value)

    order = query.get("order")
    if order:
        column, _, direction = order.partition(".")
        if not column:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="order requires a column")
        _ensure_allowed(column, allowed_set, "order")
        desc = direction.lower() == "desc"
        builder = builder.order(column, desc=desc)

    limit, offset = parse_pagination(query)
    builder = builder.range(offset, offset + limit - 1)

    result = builder.execute()
    return list(result.data or []), limit, offset
