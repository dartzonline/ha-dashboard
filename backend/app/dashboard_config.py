import json
import logging
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

logger = logging.getLogger(__name__)

TileKind = Literal["sensor", "toggle", "lock", "thermostat", "vacuum"]


class TileConfig(BaseModel):
    entityId: str
    label: str
    kind: TileKind
    icon: str


class DashboardSection(BaseModel):
    id: str
    label: str
    tiles: list[TileConfig]


class DashboardConfigPayload(BaseModel):
    sections: list[DashboardSection] | None = None
    nightModeIndoorLights: list[str] | None = None


def _storage_path() -> Path:
    data_dir = Path("/data")
    if data_dir.is_dir():
        return data_dir / "dashboard-config.json"
    fallback_dir = Path(__file__).resolve().parents[1] / "data"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    return fallback_dir / "dashboard-config.json"


def load_overrides() -> dict[str, Any]:
    path = _storage_path()
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        logger.warning("Could not read dashboard config overrides: %s", error)
        return {}
    return payload if isinstance(payload, dict) else {}


def save_overrides(payload: DashboardConfigPayload) -> dict[str, Any]:
    data = payload.model_dump(exclude_none=True)
    path = _storage_path()
    path.write_text(json.dumps(data, indent=2))
    return data


def clear_overrides() -> None:
    path = _storage_path()
    if path.is_file():
        path.unlink()
