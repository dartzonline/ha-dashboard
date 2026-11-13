"""What the plug-in car cost to charge this week, and how much of its driving was electric.

The car reports its battery level, whether the cable is connected, its odometer, its fuel and its
electric range, but no meter sits between the wall and the charger. Energy is worked out from the
battery level instead:

* **Charging.** Every rise in battery level while the cable is connected. A rise without the cable
  is regenerative braking and is not charging. Rises less than `SESSION_GAP_S` apart belong to one
  session.
* **Energy from the wall.** Percent gained x usable capacity / charger efficiency. The car reports
  its *gross* capacity; about `USABLE_FRACTION` of it is usable, and a home charger loses roughly
  `CHARGER_EFFICIENCY` of what it draws. The result is an estimate and the page says "about".
* **Electric miles.** Every fall in battery level while unplugged, at the miles-per-percent the
  car's own range estimate gives when the battery is well charged.
* **All miles.** The odometer's rise. Gas miles are what is left, and gallons are the fuel
  sensor's falls (rises are fill-ups).

The car's sensors drop to "unavailable" every few hours; those rows are skipped, so a blip neither
starts nor ends anything.
"""

from __future__ import annotations

import statistics
from datetime import datetime, tzinfo
from typing import Any, Iterable

USABLE_FRACTION = 0.79
CHARGER_EFFICIENCY = 0.85
SESSION_GAP_S = 2 * 3600.0
# Range estimates at a low charge are noisy; only well-charged readings set miles-per-percent.
RANGE_SAMPLE_MIN_PCT = 40.0
LEVEL_1_MAX_KW = 2.0

Point = tuple[float, str]


def _numbers(points: Iterable[Point]) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for when, state in points:
        try:
            result.append((when, float(state)))
        except (TypeError, ValueError):
            continue
    return result


def _state_at(points: list[Point], when: float) -> str | None:
    """The last known (live) state at `when`, ignoring unavailable blips."""
    current: str | None = None
    for stamp, state in points:
        if stamp > when:
            break
        if state not in ("unavailable", "unknown"):
            current = state
    return current


def _plugged(state: str | None) -> bool:
    text = (state or "").lower()
    return "connect" in text and "disconnect" not in text


def charging_sessions(battery: list[Point], connection: list[Point], capacity_kwh: float) -> list[dict[str, Any]]:
    """Each charge: when, from and to what level, and the energy it drew from the wall."""
    levels = _numbers(battery)
    sessions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for (before_at, before), (at, level) in zip(levels, levels[1:]):
        if level <= before or not _plugged(_state_at(connection, at)):
            continue
        if current is not None and before_at - current["endAt"] <= SESSION_GAP_S and before >= current["toPct"] - 1:
            current["endAt"], current["toPct"] = at, level
            current["gained"] += level - before
            continue
        current = {"startAt": before_at, "endAt": at, "fromPct": before, "toPct": level, "gained": level - before}
        sessions.append(current)
    per_pct = capacity_kwh * USABLE_FRACTION / 100 / CHARGER_EFFICIENCY
    for session in sessions:
        session["kwh"] = round(session.pop("gained") * per_pct, 2)
        hours = (session["endAt"] - session["startAt"]) / 3600
        session["kw"] = round(session["kwh"] / hours, 2) if hours > 0 else None
    return sessions


def miles_per_percent(range_points: list[Point], battery: list[Point]) -> float | None:
    """The car's own electric range per percent of charge, from well-charged readings."""
    ratios = []
    for at, miles in _numbers(range_points):
        level_state = _state_at(battery, at)
        try:
            level = float(level_state) if level_state is not None else None
        except ValueError:
            level = None
        if level is not None and level >= RANGE_SAMPLE_MIN_PCT and miles > 0:
            ratios.append(miles / level)
    return statistics.median(ratios) if ratios else None


def electric_drop_pct(battery: list[Point], connection: list[Point]) -> float:
    levels = _numbers(battery)
    return sum(
        before - level
        for (_, before), (at, level) in zip(levels, levels[1:])
        if level < before and not _plugged(_state_at(connection, at))
    )


def _rise(points: list[Point]) -> float:
    values = [value for _, value in _numbers(points)]
    return max(0.0, values[-1] - values[0]) if len(values) >= 2 else 0.0


def _falls(points: list[Point]) -> float:
    values = [value for _, value in _numbers(points)]
    return sum(before - after for before, after in zip(values, values[1:]) if after < before)


def car_week(
    series: dict[str, list[Point]], capacity_kwh: float | None, rate: float, zone: tzinfo, now: float,
) -> dict[str, Any]:
    """The summary for the car page. `series` maps a role ("battery", "connection", "odometer",
    "fuel", "range") to that sensor's (epoch, state) points, oldest first."""
    battery = series.get("battery", [])
    connection = series.get("connection", [])
    all_points = [point for points in series.values() for point in points]
    since = min((when for when, _ in all_points), default=None)
    capacity = capacity_kwh if capacity_kwh and capacity_kwh > 0 else None
    sessions = charging_sessions(battery, connection, capacity) if capacity else []
    kwh = round(sum(session["kwh"] for session in sessions), 1)
    total_miles = _rise(series.get("odometer", []))
    per_pct = miles_per_percent(series.get("range", []), battery)
    electric_miles = electric_drop_pct(battery, connection) * per_pct if per_pct else None
    if electric_miles is not None and total_miles:
        electric_miles = min(electric_miles, total_miles)
    share = round(electric_miles / total_miles, 2) if electric_miles is not None and total_miles >= 1 else None
    speeds = [session["kw"] for session in sessions if session["kw"]]
    typical_kw = statistics.median(speeds) if speeds else None
    gallons = _falls(series.get("fuel", []))
    gas_miles = total_miles - (electric_miles or 0.0)
    days = (now - since) / 86400 if since is not None else 0
    return {
        "since": datetime.fromtimestamp(since, zone).isoformat() if since is not None else None,
        "days": round(days, 1),
        "sessions": [
            {
                "start": datetime.fromtimestamp(session["startAt"], zone).isoformat(),
                "end": datetime.fromtimestamp(session["endAt"], zone).isoformat(),
                "fromPct": session["fromPct"], "toPct": session["toPct"], "kwh": session["kwh"], "kw": session["kw"],
                "cost": round(session["kwh"] * rate, 2),
            }
            for session in sessions
        ],
        "charges": len(sessions),
        "kwh": kwh,
        "cost": round(kwh * rate, 2),
        "rate": rate,
        "fullChargeCost": round(capacity * USABLE_FRACTION / CHARGER_EFFICIENCY * rate, 2) if capacity else None,
        "typicalKw": round(typical_kw, 2) if typical_kw else None,
        # Battery percent gained per hour at that speed, for "how charged will it be by 8:30".
        "pctPerHour": round(typical_kw * CHARGER_EFFICIENCY / (capacity * USABLE_FRACTION) * 100, 2) if typical_kw and capacity else None,
        "milesPerPct": round(per_pct, 4) if per_pct else None,
        "level1": typical_kw is not None and typical_kw < LEVEL_1_MAX_KW,
        "miles": round(total_miles, 1),
        "electricMiles": round(electric_miles, 1) if electric_miles is not None else None,
        "electricShare": share,
        "gallons": round(gallons, 2),
        # Under half a gallon the fuel gauge's rounding swamps the answer.
        "gasMpg": round(gas_miles / gallons, 1) if gallons >= 0.5 and gas_miles > 0 else None,
    }
