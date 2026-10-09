from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "Sensoo Backend"
    DATABASE_URL: str = "sqlite:///./sensoo.db"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
