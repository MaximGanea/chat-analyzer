from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = Field(default="development", alias="ENVIRONMENT")
    app_name: str = Field(default="chat-analyzer-api", alias="APP_NAME")
    app_debug: bool = Field(default=False, alias="APP_DEBUG")

    database_url: str = Field(
        default="postgresql+asyncpg://chat_user:chat_pass@localhost:5432/chat_analyzer",
        alias="DATABASE_URL",
    )

    jwt_secret_key: str = Field(default="change-me-in-prod", alias="JWT_SECRET_KEY")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    jwt_access_token_minutes: int = Field(default=15, alias="JWT_ACCESS_TOKEN_MINUTES")
    jwt_refresh_token_days: int = Field(default=7, alias="JWT_REFRESH_TOKEN_DAYS")

    cors_allowed_origins: str = Field(default="http://localhost:5173", alias="CORS_ALLOWED_ORIGINS")


@lru_cache
def get_settings() -> Settings:
    return Settings()
