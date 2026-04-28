"""Публичные endpoints для чтения данных по API-ключу."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.models import ApiKey, DataResponse, TableAccess, TableSchemaField, TableSchemaResponse, TablesResponse
from app.services.auth import authenticate
from app.services.query import execute_select, get_table_access, list_accessible_tables

router = APIRouter(prefix="/external/v1", tags=["external"])


@router.get("/tables", response_model=TablesResponse, summary="Список доступных ключу таблиц")
async def list_tables(api_key: ApiKey = Depends(authenticate)) -> TablesResponse:
    rows = list_accessible_tables(api_key.id)
    return TablesResponse(
        data=[TableAccess(table_name=r["table_name"], allowed_fields=list(r["allowed_fields"] or [])) for r in rows]
    )


@router.get("/tables/{table_name}/schema", response_model=TableSchemaResponse, summary="Схема таблицы (видимая ключу)")
async def table_schema(table_name: str, api_key: ApiKey = Depends(authenticate)) -> TableSchemaResponse:
    allowed_fields = get_table_access(api_key.id, table_name)
    if not allowed_fields:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Table is not accessible")
    return TableSchemaResponse(
        table=table_name,
        fields=[TableSchemaField(name=name) for name in allowed_fields],
    )


@router.get("/tables/{table_name}", response_model=DataResponse, summary="Чтение данных таблицы")
async def read_table(
    table_name: str,
    request: Request,
    api_key: ApiKey = Depends(authenticate),
) -> DataResponse:
    allowed_fields = get_table_access(api_key.id, table_name)
    if not allowed_fields:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Table is not accessible")

    query_params = dict(request.query_params)
    rows, limit, offset = execute_select(table_name, allowed_fields, query_params)
    return DataResponse(data=rows, limit=limit, offset=offset)
