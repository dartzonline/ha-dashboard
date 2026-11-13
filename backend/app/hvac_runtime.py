"""How long the heating and cooling run each day, whether that is creeping up, and the filter.

The thermostat reports what it is doing (`hvac_action`: cooling, heating, idle) but Home Assistant
keeps that detail for only about ten days. Each complete day is therefore summed once and kept in
a small log on the add-on, which is what lets this compare like with like over months.

* **Runtime** is time spent cooling or heating, split at midnight, with each idle-to-running switch
  counted as one cycle.
* **Like with like.** A hot day runs the AC longer; that is not a fault. Each of the last week's days
  is compared only with older days (more than two weeks back) within `MATCH_F` of the same outdoor
  average temperature. Running `LONGER_RATIO` longer than those days, consistently, is what a
  clogged filter or a dirty coil looks like. Until there are enough matching days it says so.
* **Short cycling.** Many very short runs (median under `SHORT_CYCLE_MIN` minutes) wear the
  equipment and usually mean a thermostat, sizing or refrigerant problem worth a technician.
* **Filter.** The household taps "Filter changed" and the card counts days and run hours since;
  `FILTER_DUE_DAYS` is the usual guidance for a standard 1-inch filter.
"""

from __future__ import annotations

import json
import statistics
from datetime import date, datetime, timedelta, tzinfo
from pathlib import Path
from typing import Any, Iterable

from .atomic import write_text_atomic

RUNNING = {"cooling": "coolH", "heating": "heatH"}
KEEP_DAYS = 400
MATCH_F = 2.0
MIN_RECENT_MATCHED = 4
MIN_MATCHES_PER_DAY = 2
LONGER_RATIO = 1.3
SHORT_CYCLE_MIN = 8.0
FILTER_DUE_DAYS = 90
FILTER_SOON_DAYS = 75

Point = tuple[float, str]


def daily_runtime(points: Iterable[Point], zone: tzinfo, now: float) -> dict[str, dict[str, float]]:
    """ISO date -> {coolH, heatH, cycles} for every day the points cover, split at local midnight."""
    ordered = sorted(points)
    days: dict[str, dict[str, float]] = {}

    def bucket(day: date) -> dict[str, float]:
        return days.setdefault(day.isoformat(), {"coolH": 0.0, "heatH": 0.0, "cycles": 0})

    previous: str | None = None
    for index, (start, action) in enumerate(ordered):
        end = ordered[index + 1][0] if index + 1 < len(ordered) else now
        bucket(datetime.fromtimestamp(start, zone).date())
        if action in RUNNING and previous not in RUNNING:
            bucket(datetime.fromtimestamp(start, zone).date())["cycles"] += 1
        if action in RUNNING:
            moment = start
            while moment < end:
                local = datetime.fromtimestamp(moment, zone)
                midnight = datetime(local.year, local.month, local.day, tzinfo=zone) + timedelta(days=1)
                stop = min(end, midnight.timestamp())
                bucket(local.date())[RUNNING[action]] += (stop - moment) / 3600
                moment = stop
        previous = action
    return days


class HvacLog:
    """Complete days of runtime and their outdoor temperature, plus when the filter was changed."""

    def __init__(self, path: Path | None) -> None:
        self._path = path
        self.days: dict[str, dict[str, Any]] = {}
        self.filter_changed: str | None = None
        if path is not None and path.exists():
            try:
                raw = json.loads(path.read_text())
                self.days = {key: value for key, value in (raw.get("days") or {}).items() if isinstance(value, dict)}
                changed = raw.get("filterChanged")
                self.filter_changed = changed if isinstance(changed, str) else None
            except (OSError, ValueError, AttributeError):
                self.days, self.filter_changed = {}, None

    def save(self) -> None:
        if self._path is not None:
            write_text_atomic(self._path, json.dumps({"days": self.days, "filterChanged": self.filter_changed}))

    def merge(self, runtime: dict[str, dict[str, float]], outdoor_f: dict[str, float], today: date) -> bool:
        """Adds complete days (before today); a day already logged is refreshed, never lost."""
        changed = False
        for day, values in runtime.items():
            if day >= today.isoformat():
                continue
            entry = {"coolH": round(values["coolH"], 3), "heatH": round(values["heatH"], 3), "cycles": int(values["cycles"])}
            if day in outdoor_f:
                entry["outdoorF"] = round(outdoor_f[day], 1)
            elif "outdoorF" in self.days.get(day, {}):
                entry["outdoorF"] = self.days[day]["outdoorF"]
            if self.days.get(day) != entry:
                self.days[day] = entry
                changed = True
        cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
        for day in [day for day in self.days if day < cutoff]:
            del self.days[day]
            changed = True
        return changed


def _runtime(entry: dict[str, Any]) -> float:
    return float(entry.get("coolH", 0)) + float(entry.get("heatH", 0))


def _mode(entry: dict[str, Any]) -> str | None:
    if entry.get("coolH", 0) > entry.get("heatH", 0) and entry.get("coolH", 0) > 0:
        return "cool"
    if entry.get("heatH", 0) > 0:
        return "heat"
    return None


def efficiency(days: dict[str, dict[str, Any]], today: date) -> dict[str, Any]:
    """Recent runtime against older days of similar weather."""
    recent = [(day, entry) for day, entry in days.items() if (today - timedelta(days=7)).isoformat() <= day < today.isoformat()]
    older = [(day, entry) for day, entry in days.items() if day < (today - timedelta(days=14)).isoformat()]
    ratios: list[float] = []
    for _, entry in recent:
        mode, outdoor = _mode(entry), entry.get("outdoorF")
        if mode is None or outdoor is None or _runtime(entry) < 0.25:
            continue
        matches = [
            _runtime(other) for _, other in older
            if _mode(other) == mode and other.get("outdoorF") is not None and abs(other["outdoorF"] - outdoor) <= MATCH_F and _runtime(other) >= 0.25
        ]
        if len(matches) >= MIN_MATCHES_PER_DAY:
            ratios.append(_runtime(entry) / statistics.median(matches))
    if len(ratios) < MIN_RECENT_MATCHED:
        return {"status": "learning", "ratio": None, "matchedDays": len(ratios), "loggedDays": len(days)}
    ratio = statistics.median(ratios)
    return {"status": "longer" if ratio >= LONGER_RATIO else "ok", "ratio": round(ratio, 2), "matchedDays": len(ratios), "loggedDays": len(days)}


def filter_status(log: HvacLog, today: date) -> dict[str, Any]:
    if not log.filter_changed:
        return {"changedOn": None, "days": None, "runHours": None, "status": "unknown", "dueInDays": None}
    try:
        changed = date.fromisoformat(log.filter_changed)
    except ValueError:
        return {"changedOn": None, "days": None, "runHours": None, "status": "unknown", "dueInDays": None}
    days = (today - changed).days
    logged = [entry for day, entry in log.days.items() if day >= changed.isoformat()]
    covered = bool(log.days) and min(log.days) <= changed.isoformat()
    return {
        "changedOn": changed.isoformat(),
        "days": days,
        "runHours": round(sum(_runtime(entry) for entry in logged)),
        "runHoursComplete": covered,
        "status": "due" if days >= FILTER_DUE_DAYS else "soon" if days >= FILTER_SOON_DAYS else "ok",
        "dueInDays": FILTER_DUE_DAYS - days,
    }


def hvac_report(log: HvacLog, today_runtime: dict[str, float] | None, today: date) -> dict[str, Any]:
    week = [(day, entry) for day, entry in sorted(log.days.items()) if (today - timedelta(days=7)).isoformat() <= day < today.isoformat()]
    hours = [_runtime(entry) for _, entry in week]
    cycles = sum(int(entry.get("cycles", 0)) for _, entry in week)
    run_minutes = sum(hours) * 60
    cycle_minutes = run_minutes / cycles if cycles else None
    short_cycling = cycle_minutes is not None and cycle_minutes < SHORT_CYCLE_MIN and cycles / max(1, len(week)) >= 3
    eff = efficiency(log.days, today)
    advice: list[str] = []
    if eff["status"] == "longer":
        advice.append(
            f"It ran about {round((eff['ratio'] - 1) * 100)}% longer than on days with the same weather. "
            "A clogged filter is the usual cause; after that, dirty outdoor coils."
        )
    if short_cycling:
        advice.append("Many short runs: worth a technician's look (thermostat placement, sizing or refrigerant).")
    filt = filter_status(log, today)
    if filt["status"] == "due":
        advice.append(f"The filter was changed {filt['days']} days ago; a standard 1-inch filter lasts about 90.")
    return {
        "days": [
            {"date": day, "hours": round(_runtime(entry), 2), "mode": _mode(entry), "cycles": int(entry.get("cycles", 0)), "outdoorF": entry.get("outdoorF")}
            for day, entry in week
        ],
        "weekHours": round(sum(hours), 1),
        "avgHoursPerDay": round(statistics.mean(hours), 1) if hours else None,
        "cycleMinutes": round(cycle_minutes, 1) if cycle_minutes is not None else None,
        "shortCycling": short_cycling,
        "today": {key: round(value, 2) for key, value in (today_runtime or {}).items()} or None,
        "efficiency": eff,
        "filter": filt,
        "advice": advice,
    }
