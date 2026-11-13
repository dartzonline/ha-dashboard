"""Which rooms run warmer or cooler than the thermostat, and when.

One thermostat decides for the whole house, so a room far from it, or with a closed vent, or
with afternoon sun, lives a few degrees away from the setting all the time. That only shows when
the rooms are compared over days and at the same moments.

* **Reference.** A temperature sensor that belongs to the thermostat; without one, the median of
  the rooms at each moment.
* **Sampling.** Sensors report only when the value changes, so each series is carried forward
  onto a 30-minute grid, the same grid for every room, before rooms are compared.
* **Parts of the day.** Night (0-6), morning (6-12), afternoon (12-18) and evening (18-24), in the
  house's own time, so "cold every morning" and "warm every afternoon" can be told apart.
* **Stale sensors.** A sensor that has barely changed all window while the reference moved is
  reported as stale, not as a warm or cold room: a sensor with a flat battery keeps its last
  reading forever, and a frozen 76 °F looks exactly like a hot room.

Outdoor, attic, garage, plant, appliance and car sensors are not rooms and are left out.
"""

from __future__ import annotations

import re
import statistics
from datetime import datetime, tzinfo
from typing import Any, Iterable

GRID_S = 30 * 60.0
NOT_ROOMS: tuple[str, ...] = (
    "outdoor", "outside", "open_weather", "weather", "attic", "garage", "garrage", "lawn", "plant", "garden",
    "fridge", "freezer", "refrigerator", "oven", "volvo", "car_", "wled", "cpu", "processor", "water", "pool",
    "battery", "dew", "feels", "apparent",
)
THERMOSTAT_TERMS: tuple[str, ...] = ("thermostat",)
PARTS = (("night", 0), ("morning", 6), ("afternoon", 12), ("evening", 18))
# In the sensor's own unit: about 1.1 °C. Off by this much on average is a room you notice.
OFF_F = 2.0
STRONG_F = 4.0
# A part of the day this much further off than the room's average is that room's story.
PART_STANDS_OUT_F = 1.5
STALE_MAX_CHANGES = 2
STALE_MIN_REFERENCE_CHANGES = 10
DEAD = {"unavailable", "unknown", ""}

Point = tuple[float, str]


def _searchable(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return f"{entity.get('entity_id', '')} {attributes.get('friendly_name', '')}".lower()


def _is_temperature(entity: dict[str, Any]) -> bool:
    return (
        str(entity.get("entity_id", "")).startswith("sensor.")
        and (entity.get("attributes") or {}).get("device_class") == "temperature"
        and str(entity.get("state", "")) not in DEAD
    )


def room_sensors(states: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """(room sensors, the thermostat's own sensor if it has one), live ones only."""
    rooms: list[dict[str, Any]] = []
    reference: dict[str, Any] | None = None
    for entity in states:
        if not _is_temperature(entity):
            continue
        text = _searchable(entity)
        if any(term in text for term in THERMOSTAT_TERMS):
            reference = reference or entity
        elif not any(term in text for term in NOT_ROOMS):
            rooms.append(entity)
    return rooms, reference


def clean_label(name: str) -> str:
    """'Master Bedroom Temperature Temperature' -> 'Master Bedroom'; 'Media Sensor Temperature' -> 'Media'."""
    words = [word for word in re.split(r"\s+", name.strip()) if word.lower() not in ("temperature", "sensor", "temp")]
    deduped: list[str] = []
    for word in words:
        if not deduped or deduped[-1].lower() != word.lower():
            deduped.append(word)
    # "Master Bedroom Master Bedroom" -> "Master Bedroom"
    half = len(deduped) // 2
    if half and len(deduped) % 2 == 0 and [w.lower() for w in deduped[:half]] == [w.lower() for w in deduped[half:]]:
        deduped = deduped[:half]
    return " ".join(deduped) or name


def _numeric(points: Iterable[Point]) -> list[tuple[float, float]]:
    result = []
    for when, state in points:
        try:
            result.append((when, float(state)))
        except (TypeError, ValueError):
            continue
    return result


def resample(points: list[Point], grid: list[float]) -> list[float | None]:
    """The last reading at or before each grid moment; None before the first and while unavailable."""
    ordered = sorted(points)
    values: list[float | None] = []
    index, current = 0, None
    for moment in grid:
        while index < len(ordered) and ordered[index][0] <= moment:
            state = ordered[index][1]
            try:
                current = float(state)
            except (TypeError, ValueError):
                current = None
            index += 1
        values.append(current)
    return values


def _changes(points: list[Point]) -> int:
    values = [value for _, value in _numeric(points)]
    return sum(1 for before, after in zip(values, values[1:]) if after != before)


def _part(hour: int) -> str:
    name = PARTS[0][0]
    for label, start in PARTS:
        if hour >= start:
            name = label
    return name


def _advice(status: str, offset: float, worst_part: str | None, mode: str | None, within: float) -> str:
    if status == "stale":
        return "Its reading hasn't changed for days. Check the sensor's battery before trusting it."
    if status == "balanced":
        return f"Stays within {within:.0f}° of the thermostat."
    warm = status == "warm"
    if worst_part == "afternoon" and warm:
        return "Warmest in the afternoon, which usually means sun through the windows: blinds or curtains help."
    if worst_part in ("night", "morning") and not warm:
        return f"Coldest {'overnight' if worst_part == 'night' else 'in the morning'}: check for a closed vent or a draughty window."
    if mode == "cool":
        return ("Gets less cool air than the rest of the house: open its vent fully, or partly close vents in cooler rooms."
                if warm else "Gets more cool air than it needs: partly close its vent to push air to warmer rooms.")
    if mode == "heat":
        return ("Gets more heat than it needs: partly close its vent." if warm
                else "Gets less heat than the rest of the house: open its vent fully, or partly close vents in warmer rooms.")
    return "Runs warmer than the thermostat setting." if warm else "Runs cooler than the thermostat setting."


def room_balance(
    series: dict[str, list[Point]],
    states: dict[str, dict[str, Any]],
    reference_id: str | None,
    zone: tzinfo,
    now: float,
    days: int,
    unit: str = "°F",
    mode: str | None = None,
) -> dict[str, Any]:
    """Every room's offset from the thermostat, overall and by part of the day."""
    start = now - days * 86400
    grid = [start + GRID_S * step for step in range(int(days * 86400 // GRID_S) + 1)]
    sampled = {entity_id: resample(points, grid) for entity_id, points in series.items()}
    rooms = [entity_id for entity_id in series if entity_id != reference_id]
    if reference_id is not None and reference_id in sampled:
        reference = sampled[reference_id]
        reference_changes = _changes(series[reference_id])
    else:
        reference = [
            statistics.median(column) if (column := [sampled[room][i] for room in rooms if sampled[room][i] is not None]) else None
            for i in range(len(grid))
        ]
        reference_changes = max((_changes(series[room]) for room in rooms), default=0)
    scale = 1.0 if unit in ("°F", "F") else 5 / 9
    off, strong, stands_out = OFF_F * scale, STRONG_F * scale, PART_STANDS_OUT_F * scale

    result: list[dict[str, Any]] = []
    for room in rooms:
        by_part: dict[str, list[float]] = {label: [] for label, _ in PARTS}
        for moment, value, ref in zip(grid, sampled[room], reference):
            if value is not None and ref is not None:
                by_part[_part(datetime.fromtimestamp(moment, zone).hour)].append(value - ref)
        everything = [diff for diffs in by_part.values() for diff in diffs]
        if len(everything) < 12:
            continue
        offset = statistics.mean(everything)
        parts = {label: round(statistics.mean(diffs), 1) for label, diffs in by_part.items() if diffs}
        worst_part, worst = max(parts.items(), key=lambda item: abs(item[1]))
        stale = _changes(series[room]) <= STALE_MAX_CHANGES and reference_changes >= STALE_MIN_REFERENCE_CHANGES
        if stale:
            status = "stale"
        elif offset >= off or (worst >= off and worst - offset >= stands_out):
            status = "warm"
        elif offset <= -off or (worst <= -off and offset - worst >= stands_out):
            status = "cool"
        else:
            status = "balanced"
        part_matters = abs(worst) - abs(offset) >= stands_out
        entity = states.get(room) or {}
        name = (entity.get("attributes") or {}).get("friendly_name") or room
        current = entity.get("state")
        result.append({
            "entityId": room,
            "label": clean_label(str(name)),
            "current": float(current) if _numeric([(0.0, current)]) else None,
            "offset": round(offset, 1),
            "parts": parts,
            "worstPart": worst_part if part_matters else None,
            "worst": worst,
            "status": status,
            "strong": status in ("warm", "cool") and max(abs(offset), abs(worst)) >= strong,
            "advice": _advice(status, offset, worst_part if part_matters else None, mode, off),
        })
    order = {"warm": 0, "cool": 0, "stale": 1, "balanced": 2}
    result.sort(key=lambda room: (order[room["status"]], -max(abs(room["offset"]), abs(room["worst"]))))
    live = [room["offset"] for room in result if room["status"] != "stale"]
    reference_entity = states.get(reference_id or "") or {}
    return {
        "days": days,
        "unit": unit,
        "reference": {
            "entityId": reference_id,
            "label": clean_label(str((reference_entity.get("attributes") or {}).get("friendly_name") or "Thermostat"))
            if reference_id else "House median",
            "current": float(reference_entity["state"]) if reference_id and _numeric([(0.0, reference_entity.get("state"))]) else None,
        },
        "spread": round(max(live) - min(live), 1) if len(live) >= 2 else None,
        "rooms": result,
    }
