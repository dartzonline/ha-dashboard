import json
import logging
import re
from datetime import date
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


class BinSchedulePayload(BaseModel):
    enabled: bool = True
    # Monday is 0, as in Python's `date.weekday()`; Thursday is 3.
    trashWeekday: int = Field(default=3, ge=0, le=6)
    recycling: Literal["biweekly", "weekly", "none"] = "biweekly"
    # Any date recycling is (or was) collected; fortnightly weeks are counted from it.
    recyclingAnchorDate: date | None = None
    remindStart: str = Field(default="16:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    remindEnd: str = Field(default="22:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    intervalMinutes: int = Field(default=30, ge=10, le=180)


class NotificationsPayload(BaseModel):
    targets: list[str] = Field(default_factory=list)
    forecast: bool = True
    houseWatch: bool = True
    bins: bool = True
    weekly: bool = True
    quietStart: str = Field(default="22:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quietEnd: str = Field(default="07:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @field_validator("targets")
    @classmethod
    def _notify_services(cls, value: list[str]) -> list[str]:
        bad = [item for item in value if not re.match(r"^notify\.[a-z0-9_]+$", item)]
        if bad:
            raise ValueError(f"Notification targets must be notify.* services, got: {', '.join(bad[:5])}")
        return list(dict.fromkeys(value))


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
    # House watch switches a light off after it has been on this long; the excluded lights are the
    # ones it must never touch (the nursery clock, say). Only the minutes are bounded here: a day
    # is already past any reason to have the watch at all.
    lightAutoOffMinutes: int | None = Field(default=None, ge=1, le=24 * 60)
    lightAutoOffExcludedIds: list[str] | None = None
    binSchedule: BinSchedulePayload | None = None
    notifications: NotificationsPayload | None = None

    @field_validator("nightModeIndoorLights")
    @classmethod
    def _only_light_entities(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        bad = [item for item in value if not re.match(r"^light\.", item)]
        if bad:
            raise ValueError(f"Night Mode lights must be light.* entities, got: {', '.join(bad[:5])}")
        return value

    @field_validator("lightAutoOffExcludedIds")
    @classmethod
    def _excluded_are_lights(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        bad = [item for item in value if not re.match(r"^light\.", item)]
        if bad:
            raise ValueError(f"Auto-off exclusions must be light.* entities, got: {', '.join(bad[:5])}")
        return list(dict.fromkeys(value))


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
    data = {**load_overrides(), **payload.model_dump(mode="json", exclude_none=True)}
    # Atomic so a crash mid-write cannot leave a truncated file that `load_overrides` then reads
    # as "no overrides" -- which would silently reset every tile the household has arranged.
    write_text_atomic(_storage_path(), json.dumps(data, indent=2))
    return data


def clear_overrides() -> None:
    path = _storage_path()
    if path.is_file():
        path.unlink()
