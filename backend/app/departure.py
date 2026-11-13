"""When the car usually leaves in the morning, how charged it will be by then, and whether to warm it up.

* **Leaving time.** The first garage-door opening between 5 and 11 am each day is that morning's
  departure. Weekdays and weekends are learned separately; each needs `MIN_DAYS` mornings, and
  the typical time is their median, so one early dentist run does not move it. Without a garage
  door, the first time the car reports being in use stands in.
* **Charge by then.** Plugged in and charging, the car's own "time to full" spreads the remaining
  charge evenly over that time; without it, the charging speed learned from the past week does.
  Unplugged, the level stays where it is. The car never charges past its own target.
* **Warm up or cool down.** The forecast's feels-like temperature for the departure hour: at or
  below `WARM_UP_AT_C` the card offers to start the car's climate, at or above `COOL_DOWN_AT_C` it
  offers to cool it. Starting it is always a tap, never automatic.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timedelta, tzinfo
from typing import Any, Iterable

WINDOW_START_HOUR = 5
WINDOW_END_HOUR = 11
MIN_DAYS = 3
# Shown as "leaving now" until this long after the usual time, then the next morning takes over.
STILL_LEAVING_MIN = 20
WARM_UP_AT_C = 4.5  # 40 °F
COOL_DOWN_AT_C = 29.5  # 85 °F
LOW_AT_DEPARTURE_PCT = 50.0

Point = tuple[float, str]


def morning_departures(points: Iterable[Point], zone: tzinfo, leaving_states: tuple[str, ...]) -> dict[str, int]:
    """ISO date -> minute of the day of that morning's first departure."""
    found: dict[str, int] = {}
    for when, state in sorted(points):
        if state not in leaving_states:
            continue
        local = datetime.fromtimestamp(when, zone)
        if not WINDOW_START_HOUR <= local.hour < WINDOW_END_HOUR:
            continue
        found.setdefault(local.date().isoformat(), local.hour * 60 + local.minute)
    return found


def typical_departures(found: dict[str, int]) -> dict[str, dict[str, int] | None]:
    """The usual weekday and weekend leaving minute, when there are enough mornings to tell."""
    groups: dict[str, list[int]] = {"weekday": [], "weekend": []}
    for day, minute in found.items():
        weekend = datetime.fromisoformat(day).weekday() >= 5
        groups["weekend" if weekend else "weekday"].append(minute)
    return {
        name: {"minute": round(statistics.median(minutes)), "days": len(minutes)} if len(minutes) >= MIN_DAYS else None
        for name, minutes in groups.items()
    }


def next_departure(typical: dict[str, dict[str, int] | None], now: datetime) -> datetime | None:
    """The next usual departure: this morning's while it has not long passed, else the next day with one."""
    for offset in range(0, 8):
        day = (now + timedelta(days=offset)).date()
        usual = typical["weekend" if day.weekday() >= 5 else "weekday"]
        if usual is None:
            continue
        at = datetime(day.year, day.month, day.day, usual["minute"] // 60, usual["minute"] % 60, tzinfo=now.tzinfo)
        if at + timedelta(minutes=STILL_LEAVING_MIN) >= now:
            return at
    return None


def charge_at(
    level: float, target: float, plugged: bool, charging: bool, hours: float,
    minutes_to_full: float | None, pct_per_hour: float | None,
) -> float:
    """The battery level after `hours`, never past the car's own target."""
    if not plugged or hours <= 0 or level >= target:
        return level
    if charging and minutes_to_full and minutes_to_full > 0:
        return min(target, level + (target - level) * min(1.0, hours * 60 / minutes_to_full))
    if pct_per_hour:
        return min(target, level + pct_per_hour * hours)
    return level


def feels_like_at(forecast: dict[str, Any] | None, at: datetime) -> float | None:
    """The forecast's feels-like temperature (°C) for the hour of `at`, from Open-Meteo's local-time rows."""
    hourly = (forecast or {}).get("hourly") or {}
    times = hourly.get("time") or []
    values = hourly.get("apparent_temperature") or hourly.get("temperature_2m") or []
    key = at.strftime("%Y-%m-%dT%H:00")
    for stamp, value in zip(times, values):
        if stamp == key and isinstance(value, (int, float)):
            return float(value)
    return None


def climate_suggestion(feels_like_c: float | None) -> str | None:
    if feels_like_c is None:
        return None
    if feels_like_c <= WARM_UP_AT_C:
        return "warm"
    if feels_like_c >= COOL_DOWN_AT_C:
        return "cool"
    return None


def clock_label(minute: int) -> str:
    hour, mins = divmod(minute, 60)
    return f"{(hour % 12) or 12}:{mins:02d} {'am' if hour < 12 else 'pm'}"


def departure_plan(
    *,
    found: dict[str, int],
    now: datetime,
    level: float | None,
    target: float,
    plugged: bool,
    charging: bool,
    minutes_to_full: float | None,
    pct_per_hour: float | None,
    miles_per_pct: float | None,
    forecast: dict[str, Any] | None,
) -> dict[str, Any]:
    typical = typical_departures(found)
    leave = next_departure(typical, now)
    result: dict[str, Any] = {
        "typical": {
            name: ({"time": clock_label(value["minute"]), "minute": value["minute"], "days": value["days"]} if value else None)
            for name, value in typical.items()
        },
        "mornings": len(found),
        "departure": None,
    }
    if leave is None:
        return result
    hours = max(0.0, (leave - now).total_seconds() / 3600)
    at_departure = charge_at(level, target, plugged, charging, hours, minutes_to_full, pct_per_hour) if level is not None else None
    feels = feels_like_at(forecast, leave)
    minute = leave.hour * 60 + leave.minute
    result["departure"] = {
        "at": leave.isoformat(),
        "time": clock_label(minute),
        "day": "today" if leave.date() == now.date() else "tomorrow" if leave.date() == (now + timedelta(days=1)).date() else leave.strftime("%A"),
        "hoursAway": round(hours, 2),
        "leavingNow": leave <= now,
        "level": level,
        "levelAtDeparture": round(at_departure) if at_departure is not None else None,
        "rangeAtDeparture": round(at_departure * miles_per_pct) if at_departure is not None and miles_per_pct else None,
        "plugged": plugged,
        "charging": charging,
        "target": target,
        "needsPlug": not plugged and at_departure is not None and at_departure < LOW_AT_DEPARTURE_PCT,
        "feelsLikeC": round(feels, 1) if feels is not None else None,
        "climate": climate_suggestion(feels),
    }
    return result
