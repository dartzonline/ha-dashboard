"""Morning run: the weekday drive out, and the house left behind.

Learned from this household's week: the garage opens between about 8:10 and 8:40 every weekday
morning and again around 9:05-9:30 on the way back. So between `start` and `end` on the chosen
weekdays:

* before the garage opens, a pre-departure check: the weather right now, the car's lock, doors,
  windows and range, and the garage;
* the first time the garage opens is the departure; while out, anything left unlocked, open or on
  in the house is listed, with a one-tap "Secure the house" (locks the house doors, switches off
  lights and media) -- and, if chosen in Settings, the vacuum starts once the house has been still
  for ten minutes;
* the garage opening again (ten or more minutes later) is the return.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time as clock_time
from typing import Any, Awaitable, Callable, Iterable

from . import house_watch

logger = logging.getLogger(__name__)

_CLOCK = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
RETURN_AFTER_S = 10 * 60.0
OUT_FOR_AT_MOST_S = 3 * 3600.0
BACK_SHOWN_FOR_S = 30 * 60.0
VACUUM_AFTER_STILL_S = 10 * 60.0
COLD_C = 10.0


@dataclass(frozen=True)
class RunSettings:
    enabled: bool = True
    weekdays: tuple[int, ...] = (0, 1, 2, 3, 4)
    start: clock_time = clock_time(7, 30)
    end: clock_time = clock_time(9, 45)
    vacuum: bool = False


def _clock(value: Any, default: clock_time) -> clock_time:
    match = _CLOCK.match(value) if isinstance(value, str) else None
    return clock_time(int(match.group(1)), int(match.group(2))) if match else default


def settings_from_overrides(overrides: dict[str, Any]) -> RunSettings:
    raw = overrides.get("morningRun")
    if not isinstance(raw, dict):
        return RunSettings()
    default = RunSettings()
    weekdays = raw.get("weekdays")
    return RunSettings(
        enabled=raw.get("enabled") if isinstance(raw.get("enabled"), bool) else default.enabled,
        weekdays=tuple(sorted({day for day in weekdays if isinstance(day, int) and 0 <= day <= 6})) if isinstance(weekdays, list) else default.weekdays,
        start=_clock(raw.get("start"), default.start),
        end=_clock(raw.get("end"), default.end),
        vacuum=raw.get("vacuum") if isinstance(raw.get("vacuum"), bool) else default.vacuum,
    )


def settings_as_dict(settings: RunSettings) -> dict[str, Any]:
    return {
        "enabled": settings.enabled,
        "weekdays": list(settings.weekdays),
        "start": settings.start.strftime("%H:%M"),
        "end": settings.end.strftime("%H:%M"),
        "vacuum": settings.vacuum,
    }


# --- reading the house ------------------------------------------------------------


def _name(entity: dict[str, Any]) -> str:
    return str((entity.get("attributes") or {}).get("friendly_name") or entity.get("entity_id"))


def _domain(entity: dict[str, Any]) -> str:
    return str(entity.get("entity_id", "")).split(".", 1)[0]


def _garage_open(states: Iterable[dict[str, Any]]) -> bool:
    return any(house_watch._is_garage(entity) for entity in states)


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _car_checks(states: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    car = [entity for entity in states if house_watch._mentions(entity, house_watch.CAR_TERMS)]
    lock = next((entity for entity in car if _domain(entity) == "lock"), None)
    if lock is not None and lock.get("state") in ("locked", "unlocked"):
        checks.append({"id": "car-lock", "ok": lock["state"] == "locked", "label": "Car locked" if lock["state"] == "locked" else "Car unlocked"})
    open_parts = [
        _name(entity) for entity in car
        if _domain(entity) == "binary_sensor" and entity.get("state") == "on"
        and (entity.get("attributes") or {}).get("device_class") in ("door", "window", "opening")
    ]
    if any(_domain(entity) == "binary_sensor" and (entity.get("attributes") or {}).get("device_class") in ("door", "window") for entity in car):
        checks.append({"id": "car-closed", "ok": not open_parts, "label": "Car doors and windows closed" if not open_parts else f"Open: {', '.join(open_parts[:3])}"})
    for entity in car:
        if "distance_to_empty" in str(entity.get("entity_id")) or "range" in str(entity.get("entity_id")):
            value = _number(entity.get("state"))
            if value is not None:
                unit = (entity.get("attributes") or {}).get("unit_of_measurement") or ""
                checks.append({"id": "car-range", "ok": value >= 30, "label": f"Range {value:.0f} {unit}".strip()})
                break
    return checks


def _weather_checks(states: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weather = next((entity for entity in states if entity.get("entity_id") == "weather.forecast_home"), None) or next(
        (entity for entity in states if _domain(entity) == "weather"), None)
    if weather is None:
        return []
    checks: list[dict[str, Any]] = []
    condition = str(weather.get("state") or "")
    if condition in house_watch.RAIN_CONDITIONS or condition in ("rainy", "pouring", "lightning-rainy"):
        checks.append({"id": "rain", "ok": False, "label": "Raining: take an umbrella"})
    attributes = weather.get("attributes") or {}
    temp_c = house_watch._celsius(attributes.get("temperature"), attributes.get("temperature_unit"))
    if temp_c is not None and temp_c <= COLD_C:
        shown = f"{attributes.get('temperature')}{attributes.get('temperature_unit') or ''}"
        checks.append({"id": "cold", "ok": False, "label": f"Jacket weather: {shown}"})
    return checks


def left_behind(states: list[dict[str, Any]], settings: house_watch.WatchSettings | None = None) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]]]:
    """What is unlocked, open or on in the house, and the service calls that would secure it."""
    watch = settings or house_watch.current_settings()
    items: list[dict[str, Any]] = []
    actions: list[tuple[str, str, str]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        domain = _domain(entity)
        if domain == "lock" and entity.get("state") == "unlocked" and not house_watch._is_car(entity):
            items.append({"entityId": entity_id, "label": f"{_name(entity)} unlocked", "fixable": True})
            actions.append(("lock", "lock", entity_id))
        elif domain == "binary_sensor" and house_watch._is_opening(entity):
            items.append({"entityId": entity_id, "label": f"{_name(entity)} open", "fixable": False})
        elif house_watch._is_garage(entity):
            items.append({"entityId": entity_id, "label": f"{_name(entity)} open", "fixable": False})
        elif (
            domain == "light" and entity.get("state") == "on" and not house_watch.is_group(entity)
            and not house_watch.is_exempt_light(entity) and entity_id not in watch.light_excluded_ids
        ):
            items.append({"entityId": entity_id, "label": f"{_name(entity)} on", "fixable": True})
            actions.append(("light", "turn_off", entity_id))
        elif domain == "media_player" and entity.get("state") == "playing" and not house_watch._mentions(entity, ("rest", "hatch", "nursery")):
            items.append({"entityId": entity_id, "label": f"{_name(entity)} playing", "fixable": True})
            actions.append(("media_player", "turn_off", entity_id))
    return items, actions


# --- tracking the run ----------------------------------------------------------------


@dataclass
class RunDay:
    day: date
    departed_at: float | None = None
    returned_at: float | None = None
    vacuum_started: bool = False
    notified: bool = False
    garage_was_open: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


class MorningRun:
    """Watches the garage on run mornings; `tick` is called every house-watch pass."""

    def __init__(self) -> None:
        self.today: RunDay | None = None

    def _in_window(self, local: datetime, settings: RunSettings) -> bool:
        return settings.enabled and local.weekday() in settings.weekdays and settings.start <= local.time() <= settings.end

    def observe(self, states: list[dict[str, Any]], now: float, local: datetime, settings: RunSettings) -> None:
        if self.today is None or self.today.day != local.date():
            self.today = RunDay(day=local.date())
        run = self.today
        garage_open = _garage_open(states)
        opened_now = garage_open and not run.garage_was_open
        run.garage_was_open = garage_open
        if not opened_now:
            return
        if run.departed_at is None and self._in_window(local, settings):
            run.departed_at = now
        elif run.departed_at is not None and run.returned_at is None and now - run.departed_at >= RETURN_AFTER_S:
            run.returned_at = now

    def status(self, states: list[dict[str, Any]], now: float, local: datetime, settings: RunSettings) -> dict[str, Any]:
        run = self.today if self.today is not None and self.today.day == local.date() else None
        base = {"phase": None, "settings": settings_as_dict(settings)}
        if not settings.enabled or local.weekday() not in settings.weekdays:
            return base
        departed = run.departed_at if run else None
        returned = run.returned_at if run else None
        if departed is None:
            if not self._in_window(local, settings):
                return base
            return {**base, "phase": "before", "checks": _weather_checks(states) + _car_checks(states),
                    "garageOpen": _garage_open(states)}
        if returned is None and now - departed <= OUT_FOR_AT_MOST_S:
            items, actions = left_behind(states)
            return {**base, "phase": "out", "departedAt": _iso(departed), "leftBehind": items,
                    "canSecure": bool(actions), "vacuumStarted": bool(run and run.vacuum_started)}
        if returned is not None and now - returned <= BACK_SHOWN_FOR_S:
            return {**base, "phase": "back", "departedAt": _iso(departed), "returnedAt": _iso(returned)}
        return base

    async def maybe_vacuum(
        self, states: list[dict[str, Any]], now: float, settings: RunSettings,
        call_service: Callable[[str, str, dict[str, Any]], Awaitable[Any]],
    ) -> bool:
        """Starts the vacuum once per run, after the house has been still for ten minutes."""
        run = self.today
        if not settings.vacuum or run is None or run.departed_at is None or run.returned_at is not None or run.vacuum_started:
            return False
        if now - run.departed_at < VACUUM_AFTER_STILL_S or now - run.departed_at > OUT_FOR_AT_MOST_S:
            return False
        last_motion = house_watch.latest_motion(states, now)
        if last_motion is not None and now - last_motion < VACUUM_AFTER_STILL_S:
            return False
        vacuum = next((entity for entity in states if _domain(entity) == "vacuum" and entity.get("state") == "docked"), None)
        if vacuum is None:
            return False
        run.vacuum_started = True
        try:
            await call_service("vacuum", "start", {"entity_id": vacuum["entity_id"]})
        except Exception as error:  # noqa: BLE001 - a missed clean is not worth retrying all morning
            logger.warning("Morning run could not start the vacuum: %s", error)
            return False
        return True


def _iso(timestamp: float) -> str:
    from datetime import timezone

    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
