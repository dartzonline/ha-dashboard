"""Is the fridge using more electricity than it used to?

A fridge that slowly needs more energy is telling you something: dusty condenser coils, a door
seal that no longer seals, or a setting colder than it needs to be. The change is a few percent a
month, invisible day to day, so it is read from Home Assistant's long-term statistics (kept for
months, unlike the ten days of detailed history).

* **Daily use** is each day's `change` in the fridge's energy counter.
* **Reporting noise.** The fridge reports through its maker's cloud, which sometimes books a
  day's use on the next day (a 0 followed by a double), and the monthly counter resets on the
  1st. So the last day of each month and the 1st are dropped, and days are compared as averages
  over a fortnight, never one by one.
* **Recent vs usual.** The last `RECENT_DAYS` complete days against the median daily use of the
  `BASELINE_DAYS` before them.
* **Settings.** A freezer set below 0 °F (-18 °C) or a fridge below 37 °F (3 °C) uses more than it
  needs to, and is said so whatever the trend.
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta, tzinfo
from typing import Any, Iterable

RECENT_DAYS = 14
BASELINE_DAYS = 90
MIN_BASELINE_DAYS = 21
WATCH_RISE = 0.10
HIGH_RISE = 0.25
FREEZER_ENOUGH_F = 0.0
FRIDGE_ENOUGH_F = 37.0


def daily_use(rows: Iterable[dict[str, Any]], zone: tzinfo, scale_to_kwh: float) -> dict[date, float]:
    """Day -> kWh from daily statistics rows, without month-boundary days."""
    days: dict[date, float] = {}
    for row in rows:
        start, change = row.get("start"), row.get("change")
        if not isinstance(start, (int, float)) or not isinstance(change, (int, float)) or change < 0:
            continue
        day = datetime.fromtimestamp(start / 1000, zone).date()
        if day.day == 1 or (day + timedelta(days=1)).day == 1:
            continue
        days[day] = change * scale_to_kwh
    return days


def weekly_averages(days: dict[date, float], today: date, weeks: int = 16) -> list[dict[str, Any]]:
    """kWh/day for each of the last `weeks` weeks, oldest first, for a small chart."""
    result = []
    for back in range(weeks, 0, -1):
        end = today - timedelta(days=7 * (back - 1))
        values = [days[day] for day in days if end - timedelta(days=7) <= day < end]
        if len(values) >= 4:
            result.append({"weekEnding": (end - timedelta(days=1)).isoformat(), "kwhPerDay": round(statistics.mean(values), 2)})
    return result


def _fahrenheit(value: Any, unit: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if unit in ("°F", "F") else number * 9 / 5 + 32


def settings_advice(states: Iterable[dict[str, Any]]) -> list[str]:
    advice: list[str] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("number.") or "refrigerator" not in entity_id and "fridge" not in entity_id and "freezer" not in entity_id:
            continue
        if not entity_id.endswith("_temperature"):
            continue
        unit = (entity.get("attributes") or {}).get("unit_of_measurement")
        value = _fahrenheit(entity.get("state"), unit)
        if value is None:
            continue
        shown = f"{entity.get('state')}{unit or ''}"
        if "freezer" in entity_id and value < FREEZER_ENOUGH_F - 0.5:
            advice.append(f"The freezer is set to {shown}. 0 °F (-18 °C) keeps food safe and uses less.")
        elif "freezer" not in entity_id and value < FRIDGE_ENOUGH_F - 0.5:
            advice.append(f"The fridge is set to {shown}. 37 °F (3 °C) is cold enough and uses less.")
    return advice


def fridge_trend(days: dict[date, float], today: date, rate: float, states: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    complete = {day: value for day, value in days.items() if day < today}
    recent_days = [day for day in complete if day >= today - timedelta(days=RECENT_DAYS)]
    baseline_days = [day for day in complete if today - timedelta(days=RECENT_DAYS + BASELINE_DAYS) <= day < today - timedelta(days=RECENT_DAYS)]
    recent = statistics.mean(complete[day] for day in recent_days) if len(recent_days) >= 7 else None
    usual = statistics.median(complete[day] for day in baseline_days) if len(baseline_days) >= MIN_BASELINE_DAYS else None
    rise = (recent / usual - 1) if recent is not None and usual else None
    status = "learning" if rise is None else "high" if rise >= HIGH_RISE else "watch" if rise >= WATCH_RISE else "ok"
    advice = settings_advice(states)
    if status in ("watch", "high"):
        advice = [
            "Vacuum the condenser coils (behind the kick plate or at the back): dust there is the usual cause.",
            "Check the door seals: a sheet of paper shut in the door should be hard to pull out.",
            *advice,
        ]
    return {
        "status": status,
        "recentKwhPerDay": round(recent, 2) if recent is not None else None,
        "usualKwhPerDay": round(usual, 2) if usual is not None else None,
        "rise": round(rise, 3) if rise is not None else None,
        "yearlyCost": round(recent * 365 * rate) if recent is not None else None,
        "baselineDays": len(baseline_days),
        "weeks": weekly_averages(complete, today),
        "advice": advice,
    }
