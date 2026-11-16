import json
import logging
import re
from datetime import date
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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
    routines: bool = True
    quietStart: str = Field(default="22:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quietEnd: str = Field(default="07:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @field_validator("targets")
    @classmethod
    def _notify_services(cls, value: list[str]) -> list[str]:
        bad = [item for item in value if not re.match(r"^notify\.[a-z0-9_]+$", item)]
        if bad:
            raise ValueError(f"Notification targets must be notify.* services, got: {', '.join(bad[:5])}")
        return list(dict.fromkeys(value))


class MorningRunPayload(BaseModel):
    enabled: bool = True
    # Monday is 0.
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    start: str = Field(default="07:30", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(default="09:45", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    vacuum: bool = False

    @field_validator("weekdays")
    @classmethod
    def _weekdays(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("Weekdays run from 0 (Monday) to 6 (Sunday)")
        return sorted(set(value))


class GuestWifiPayload(BaseModel):
    """The network the Share Wi-Fi button shows as a QR code."""

    ssid: str = Field(min_length=1, max_length=32)
    security: Literal["WPA", "WEP", "nopass"] = "WPA"
    # None keeps the stored password on an edit; the settings screen never gets it back to show.
    password: str | None = Field(default=None, max_length=63)
    hidden: bool = False

    @model_validator(mode="after")
    def _password_fits_the_security(self) -> "GuestWifiPayload":
        if self.security == "WPA" and self.password is not None and len(self.password) < 8:
            raise ValueError("A WPA password is at least 8 characters")
        if self.security == "WEP" and self.password is not None and len(self.password) < 5:
            raise ValueError("A WEP password is at least 5 characters")
        return self


class QuickLink(BaseModel):
    """One address the Share button turns into a QR code: a name and where it goes."""

    label: str = Field(min_length=1, max_length=40)
    url: str = Field(min_length=8, max_length=300)

    @field_validator("label")
    @classmethod
    def _label_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Give the link a name")
        return value

    @field_validator("url")
    @classmethod
    def _url_is_a_web_address(cls, value: str) -> str:
        value = value.strip()
        # A phone opens what it scans, so only plain web addresses are accepted: no javascript:,
        # no file:, no embedded spaces.
        if not re.match(r"^https?://[^\s/]+[^\s]*$", value, re.IGNORECASE):
            raise ValueError("Use a web address that starts with http:// or https://")
        return value


class DashboardConfigPayload(BaseModel):
    sections: list[DashboardSection] | None = None
    # Night Mode only ever calls `light.turn_off` on these, so anything that is not a `light.`
    # entity would be silently ignored at best -- reject it at the edge so the editor hears about
    # a bad entry instead of the routine quietly skipping it every night.
    nightModeIndoorLights: list[str] | None = None
    # A negative or NaN rate would render as a nonsense bill; `allow_inf_nan=False` is what turns
    # a JSON `NaN` (which Python's parser accepts) into a 422 rather than a stored poison value.
    energyRatePerKwh: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    # The utility's fixed monthly charge (service availability), billed whatever the usage.
    energyFixedMonthly: float | None = Field(default=None, ge=0, le=1000, allow_inf_nan=False)
    # Entities the household has explicitly declined from the "New devices" tray, so discovery
    # (docs/auto-entity-discovery.md) stops re-proposing them every session.
    ignoredEntityIds: list[str] | None = None
    # House watch switches a light off after it has been on this long; the excluded lights are the
    # ones it must never touch (the nursery clock, say). Only the minutes are bounded here: a day
    # is already past any reason to have the watch at all.
    lightAutoOffMinutes: int | None = Field(default=None, ge=1, le=24 * 60)
    lightAutoOffExcludedIds: list[str] | None = None
    binSchedule: BinSchedulePayload | None = None
    morningRun: MorningRunPayload | None = None
    guestWifi: GuestWifiPayload | None = None
    # Named addresses for the Share button's QR codes. An empty list clears them (the merging save
    # drops only None, so [] is how a household takes them all back).
    quickLinks: list[QuickLink] | None = Field(default=None, max_length=12)
    notifications: NotificationsPayload | None = None
    # The whole-home energy meter, picked on the Energy page. "" puts it back to automatic (the
    # merging save drops nulls, so an empty string is how a choice is taken back).
    wholeHomeEnergyEntity: str | None = Field(default=None, max_length=255, pattern=r"^(sensor\.[a-z0-9_]+)?$")

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
