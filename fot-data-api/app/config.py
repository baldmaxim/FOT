from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Конфиг сервиса. Значения берутся из .env (не коммитим)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    SUPABASE_URL: str = Field(..., description="URL Supabase Cloud")
    SUPABASE_SERVICE_ROLE_KEY: str = Field(..., description="Service role key — даёт полный доступ, обходит RLS")
    PORT: int = 4001
    DEFAULT_RATE_LIMIT_PER_MINUTE: int = 60


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
