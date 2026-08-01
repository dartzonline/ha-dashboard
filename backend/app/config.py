from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    ha_url: str
    ha_token: str
    cors_origins: tuple[str, ...]

    @property
    def configured(self) -> bool:
        return bool(self.ha_url and self.ha_token)

    @property
    def websocket_url(self) -> str:
        base = self.ha_url.rstrip("/")
        if base.startswith("https://"):
            base = "wss://" + base.removeprefix("https://")
        elif base.startswith("http://"):
            base = "ws://" + base.removeprefix("http://")
        return f"{base}/api/websocket"


def load_settings() -> Settings:
    origins = os.getenv("CORS_ORIGINS", "http://localhost:5173")
    supervisor_token = os.getenv("SUPERVISOR_TOKEN", "").strip()
    return Settings(
        ha_url=(os.getenv("HA_URL", "").strip() or ("http://supervisor/core" if supervisor_token else "")).rstrip("/"),
        ha_token=os.getenv("HA_TOKEN", "").strip() or supervisor_token,
        cors_origins=tuple(origin.strip() for origin in origins.split(",") if origin.strip()),
    )
