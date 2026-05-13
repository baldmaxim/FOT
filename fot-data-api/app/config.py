from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Конфиг сервиса. Значения берутся из .env (не коммитим)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    DATABASE_URL: str = Field(..., description="postgres://user:pass@host:port/dbname")
    DATABASE_SSL: bool = Field(default=True, description="Включает TLS (sslmode=require/verify-full)")
    DATABASE_SSL_CA_PATH: str | None = Field(default=None, description="Путь к корневому CA для verify-full")
    DATABASE_POOL_MAX: int = Field(default=10, description="Максимум коннектов в пуле psycopg")
    PORT: int = 4001
    DEFAULT_RATE_LIMIT_PER_MINUTE: int = 60


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
