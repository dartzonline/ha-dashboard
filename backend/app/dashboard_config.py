import json
import logging
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from .atomic import write_text_atomic

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
    # Night Mode only ever calls `light.turn_off` on these, so anything that is not a `light.`
    # entity would be silently ignored at best -- reject it at the edge so the editor hears about
    # a bad entry instead of the routine quietly skipping it every night.
    nightModeIndoorLights: list[str] | None = None
    # A negative or NaN rate would render as a nonsense bill; `allow_inf_nan=False` is what turns
    # a JSON `NaN` (which Python's parser accepts) into a 422 rather than a stored poison value.
    energyRatePerKwh: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    # Entities the household has explicitly declined from the "New devices" tray, so discovery
    # (docs/auto-entity-discovery.md) stops re-proposing them every session.
    ignoredEntityIds: list[str] | None = None

    @field_validator("nightModeIndoorLights")
    @classmethod
    def _only_light_entities(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        bad = [item for item in value if not re.match(r"^light\.", item)]
        if bad:
            raise ValueError(f"Night Mode lights must be light.* entities, got: {', '.join(bad[:5])}")
        return value


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
    """Merges the supplied keys over what is already stored.

    Callers send only the slice they own -- the tile editor sends sections and Night Mode lights,
    the energy panel sends just its rate -- so a partial save must not wipe the other's settings.
    """
    data = {**load_overrides(), **payload.model_dump(exclude_none=True)}
    # Atomic so a crash mid-write cannot leave a truncated file that `load_overrides` then reads
    # as "no overrides" -- which would silently reset every tile the household has arranged.
    write_text_atomic(_storage_path(), json.dumps(data, indent=2))
    return data


def clear_overrides() -> None:
    path = _storage_path()
    if path.is_file():
        path.unlink()
