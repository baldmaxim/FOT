from datetime import datetime
from typing import Any

from pydantic import BaseModel


class ApiKey(BaseModel):
    """In-memory представление API-ключа после успешной аутентификации."""

    id: str
    name: str
    rate_limit_per_minute: int
    revoked_at: datetime | None = None
    expires_at: datetime | None = None


class TableAccess(BaseModel):
    table_name: str
    allowed_fields: list[str]


class TablesResponse(BaseModel):
    data: list[TableAccess]


class TableSchemaField(BaseModel):
    name: str


class TableSchemaResponse(BaseModel):
    table: str
    fields: list[TableSchemaField]


class DataResponse(BaseModel):
    data: list[dict[str, Any]]
    limit: int
    offset: int
