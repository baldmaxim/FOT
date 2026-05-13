"""Построение безопасных SELECT-запросов поверх psycopg.

Все имена таблиц и колонок проверяются по whitelist `data_api_key_tables`
(см. ``get_table_access``). Idents оборачиваются в `psycopg.sql.Identifier`,
values уходят строго через параметры. Никакого f-string SQL.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from psycopg import sql

from app.lib.postgres import fetch_all, fetch_one

# Поддерживаемые префиксы query-параметров: значение проверяется по полю,
# которое явно перечислено в allowed_fields ключа.
_FILTER_OPERATORS = {"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"}
_RESERVED_PARAMS = {"limit", "offset", "order"}

MAX_LIMIT = 1000
DEFAULT_LIMIT = 100


async def get_table_access(api_key_id: str, table_name: str) -> list[str] | None:
    """Возвращает список allowed_fields для пары ключ/таблица или None."""
    row = await fetch_one(
        """
        SELECT allowed_fields
          FROM data_api_key_tables
         WHERE key_id = %s AND table_name = %s
         LIMIT 1
        """,
        (api_key_id, table_name),
    )
    if not row:
        return None
    fields = row.get("allowed_fields") or []
    return list(fields) if fields else None


async def list_accessible_tables(api_key_id: str) -> list[dict[str, Any]]:
    rows = await fetch_all(
        """
        SELECT table_name, allowed_fields
          FROM data_api_key_tables
         WHERE key_id = %s
         ORDER BY table_name ASC
        """,
        (api_key_id,),
    )
    return rows


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


_OP_TO_SQL = {
    "eq": "=",
    "neq": "<>",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
    "like": "LIKE",
    "ilike": "ILIKE",
}


def _build_filter_clause(op: str, column: str, value: str) -> tuple[sql.Composed, list[Any]]:
    """Собирает кусок WHERE и параметры."""
    col_ident = sql.Identifier(column)
    if op in _OP_TO_SQL:
        return sql.SQL("{col} {op} %s").format(
            col=col_ident,
            op=sql.SQL(_OP_TO_SQL[op]),
        ), [value]
    if op == "in":
        values = [v for v in value.split(",") if v]
        if not values:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"in.{column} requires at least one value",
            )
        return sql.SQL("{col} = ANY(%s)").format(col=col_ident), [values]
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported operator '{op}'")


async def execute_select(
    table_name: str,
    allowed_fields: list[str],
    query: dict[str, str],
) -> tuple[list[dict[str, Any]], int, int]:
    if not allowed_fields:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No fields allowed for this table")
    allowed_set = set(allowed_fields)

    # SELECT col1, col2, ... FROM table — все имена через Identifier.
    select_idents = sql.SQL(", ").join(sql.Identifier(f) for f in allowed_fields)
    table_ident = sql.Identifier(table_name)

    where_parts: list[sql.Composed] = []
    params: list[Any] = []

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
        clause, clause_params = _build_filter_clause(op, column, raw_value)
        where_parts.append(clause)
        params.extend(clause_params)

    order_clause: sql.Composed | None = None
    order = query.get("order")
    if order:
        column, _, direction = order.partition(".")
        if not column:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="order requires a column")
        _ensure_allowed(column, allowed_set, "order")
        desc = direction.lower() == "desc"
        order_clause = sql.SQL("ORDER BY {col} {dir}").format(
            col=sql.Identifier(column),
            dir=sql.SQL("DESC") if desc else sql.SQL("ASC"),
        )

    limit, offset = parse_pagination(query)

    statement = sql.SQL("SELECT {fields} FROM {table}").format(fields=select_idents, table=table_ident)
    if where_parts:
        statement = statement + sql.SQL(" WHERE ") + sql.SQL(" AND ").join(where_parts)
    if order_clause is not None:
        statement = statement + sql.SQL(" ") + order_clause
    statement = statement + sql.SQL(" LIMIT %s OFFSET %s")
    params.extend([limit, offset])

    rows = await fetch_all(statement, tuple(params))
    return rows, limit, offset
