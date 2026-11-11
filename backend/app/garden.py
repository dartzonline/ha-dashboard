"""Plant care: soil moisture sensors read against the rain forecast.

A dry plant with a soaking due tonight should be left alone; a dry plant on a dry, hot day should
be watered early. The plant sensors are found the same way the dashboard's Utility rail finds them:
a moisture or humidity sensor whose name mentions a plant, soil, the lawn or the garden.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from .weather_advice import Advice, Units, hours, local_now

DRY_PERCENT = 20.0
VERY_DRY_PERCENT = 10.0
SOAKING_RAIN_MM = 5.0
HOT_C = 30.0

_PLANT = re.compile(r"(plant|soil|flower|garden|lawn|maple|magnolia)")
_MOISTURE = re.compile(r"(humidity|moisture)")
_IRRIGATION = re.compile(r"(irrigation|sprinkler|drip)")
_NAME_NOISE = re.compile(r"\b(soil|moisture|humidity|sensor|plant sensor)\b", re.IGNORECASE)


def _name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return str(attributes.get("friendly_name") or entity.get("entity_id") or "")


def plant_moisture(states: list[dict[str, Any]]) -> list[tuple[dict[str, Any], float]]:
    plants = []
    for entity in states:
        if not str(entity.get("entity_id", "")).startswith("sensor."):
            continue
        searchable = f"{entity.get('entity_id', '')} {_name(entity)}".lower()
        if not (_PLANT.search(searchable) and _MOISTURE.search(searchable)):
            continue
        try:
            plants.append((entity, float(entity.get("state"))))
        except (TypeError, ValueError):
            continue
    return plants


def _short_name(entity: dict[str, Any]) -> str:
    """'Lawn plant sensor maple humidity' reads better as 'Lawn maple'."""
    cleaned = re.sub(r"\s+", " ", _NAME_NOISE.sub("", _name(entity))).strip()
    return cleaned or _name(entity)


def _when(at: datetime, now: datetime) -> str:
    if at.date() == now.date():
        return "tonight" if at.hour >= 18 else "today"
    if at.date() == now.date() + timedelta(days=1) and at.hour < 8:
        return "tonight"
    return "tomorrow"


def garden_advice(states: list[dict[str, Any]], forecast: dict[str, Any], imperial: bool, now: float | None = None) -> list[Advice]:
    local = local_now(forecast, now)
    next_day = [hour for hour in hours(forecast) if local <= hour.at < local + timedelta(hours=24)]
    rain = sum(max(0.0, hour.precipitation - hour.snowfall_cm) for hour in next_day)
    first_rain = next((hour.at for hour in next_day if hour.precipitation - hour.snowfall_cm >= 0.3), None)
    hottest = max((hour.temp for hour in next_day if hour.temp is not None), default=None)
    units = Units(imperial)
    when = _when(first_rain, local) if first_rain else "soon"
    advice: list[Advice] = []

    for entity, moisture in sorted(plant_moisture(states), key=lambda item: item[1]):
        if moisture > DRY_PERCENT:
            continue
        name = _short_name(entity)
        entity_id = str(entity.get("entity_id"))
        if rain >= SOAKING_RAIN_MM:
            advice.append(Advice(f"garden-skip:{entity_id}", "today", "today", "info", "garden",
                                 f"Skip watering {name}",
                                 f"The soil is at {moisture:.0f}%, but {units.rain(rain)} of rain is due {when}."))
        else:
            hot = hottest is not None and hottest >= HOT_C
            advice.append(Advice(f"garden-water:{entity_id}", "today", "today",
                                 "warning" if moisture <= VERY_DRY_PERCENT else "info", "garden",
                                 f"Water {name} today",
                                 f"The soil is at {moisture:.0f}% and no real rain is due"
                                 + (" — water early, before the heat." if hot else ".")))

    has_sprinklers = any(
        str(entity.get("entity_id", "")).split(".", 1)[0] in ("switch", "valve")
        and _IRRIGATION.search(f"{entity.get('entity_id', '')} {_name(entity)}".lower())
        for entity in states
    )
    if has_sprinklers and rain >= SOAKING_RAIN_MM:
        advice.append(Advice("garden-sprinklers:today", "today", "today", "info", "garden", "Pause the sprinklers",
                             f"{units.rain(rain).capitalize()} of rain is due {when}; let it do the watering."))
    return advice
