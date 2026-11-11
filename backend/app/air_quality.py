"""Air-quality advice: the air outside against the air inside.

Two readings and one appliance: an outdoor AQI sensor, an indoor PM2.5 sensor, and the air
purifier. The useful sentences are the ones about what to *do* -- shut the windows and turn the
purifier up when it is smoky outside, open them when the air is good and the day is mild, and look
into it when the air indoors turns bad.
"""

from __future__ import annotations

from typing import Any

from . import house_watch
from .weather_advice import Advice

DEAD = {"unavailable", "unknown"}
GOOD_AQI = 50
OPEN_WINDOWS_AQI = 60
POOR_AQI = 100
BAD_AQI = 150
PM25_NOTICE = 25.0
PM25_POOR = 35.0
PM25_BAD = 55.0
MILD_C = (15.0, 26.0)

_BANDS = ((50, "good"), (100, "moderate"), (150, "unhealthy for sensitive groups"), (200, "unhealthy"), (300, "very unhealthy"))


def aqi_band(value: float) -> str:
    return next((label for limit, label in _BANDS if value <= limit), "hazardous")


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _named(entity: dict[str, Any], term: str) -> bool:
    return term in f"{entity.get('entity_id', '')} {(entity.get('attributes') or {}).get('friendly_name', '')}".lower()


def snapshot(states: list[dict[str, Any]]) -> dict[str, Any] | None:
    """What the house knows about air right now, or None when it has no air sensors at all."""
    outdoor_aqi: float | None = None
    indoor_pm25: float | None = None
    for entity in states:
        if not str(entity.get("entity_id", "")).startswith("sensor.") or entity.get("state") in DEAD:
            continue
        device_class = (entity.get("attributes") or {}).get("device_class")
        value = _number(entity.get("state"))
        if value is None:
            continue
        if device_class == "aqi" and _named(entity, "outdoor"):
            outdoor_aqi = value
        elif device_class == "pm25" and not _named(entity, "outdoor"):
            indoor_pm25 = value
    if outdoor_aqi is None and indoor_pm25 is None:
        return None

    purifier = next(
        (entity for entity in states if str(entity.get("entity_id", "")).startswith("fan.")
         and (_named(entity, "dyson") or _named(entity, "purifier"))), None,
    )
    weather = next((entity for entity in states if entity.get("entity_id") == "weather.forecast_home"), None) or next(
        (entity for entity in states if str(entity.get("entity_id", "")).startswith("weather.")), None)
    attributes = (weather or {}).get("attributes") or {}
    outdoor_c = house_watch._celsius(attributes.get("temperature"), attributes.get("temperature_unit"))
    thermostat = next((entity for entity in states if str(entity.get("entity_id", "")).startswith("climate.")), None)
    indoor_c = house_watch._celsius(
        ((thermostat or {}).get("attributes") or {}).get("current_temperature"),
        attributes.get("temperature_unit"),
    )
    percentage = ((purifier or {}).get("attributes") or {}).get("percentage")
    return {
        "outdoorAqi": outdoor_aqi,
        "outdoorBand": aqi_band(outdoor_aqi) if outdoor_aqi is not None else None,
        "indoorPm25": indoor_pm25,
        "purifier": None if purifier is None else {
            "on": purifier.get("state") == "on",
            "percentage": percentage if isinstance(percentage, (int, float)) else None,
            "name": (purifier.get("attributes") or {}).get("friendly_name") or purifier.get("entity_id"),
        },
        "raining": (weather or {}).get("state") in house_watch.RAIN_CONDITIONS,
        "outdoorC": outdoor_c,
        "indoorC": indoor_c,
    }


def air_advice(snap: dict[str, Any] | None) -> list[Advice]:
    if snap is None:
        return []
    found: list[Advice] = []
    outdoor, pm25 = snap["outdoorAqi"], snap["indoorPm25"]
    purifier = snap["purifier"]

    def add(rule: str, severity: str, title: str, detail: str) -> None:
        found.append(Advice(f"air-{rule}:today", "today", "today", severity, "air", title, detail))

    if outdoor is not None and outdoor > POOR_AQI:
        run_it = " Run the purifier on high." if purifier is not None else ""
        add("outdoor", "critical" if outdoor > BAD_AQI else "warning",
            f"Poor air outside: AQI {outdoor:.0f} ({snap['outdoorBand']})",
            "Keep the windows shut and skip outdoor exercise."
            + run_it + (" The air inside is clean, so shutting up is working." if pm25 is not None and pm25 < PM25_NOTICE else ""))
    elif (
        outdoor is not None and outdoor <= OPEN_WINDOWS_AQI and not snap["raining"]
        and snap["outdoorC"] is not None and MILD_C[0] <= snap["outdoorC"] <= MILD_C[1]
        and (snap["indoorC"] is None or snap["indoorC"] >= snap["outdoorC"] + 1.0)
    ):
        word = "good" if outdoor <= GOOD_AQI else "decent"
        add("windows", "info", f"Fresh air outside: AQI {outdoor:.0f}",
            f"The air outside is {word} and it's mild: a good time to open the windows and give the house a rinse.")

    if pm25 is not None and pm25 >= PM25_NOTICE:
        if purifier is None:
            action = "Open a window if the air outside is better, and check for cooking smoke."
        elif not purifier["on"]:
            action = "The purifier is off; turn it on."
        elif purifier["percentage"] is not None and purifier["percentage"] < 70:
            action = f"The purifier is at {purifier['percentage']:.0f}%; turn it up."
        else:
            action = "The purifier is already working on it; check for cooking smoke or a candle."
        add("indoor", "critical" if pm25 >= PM25_BAD else "warning" if pm25 >= PM25_POOR else "info",
            f"Indoor air is {'poor' if pm25 >= PM25_POOR else 'a little dusty'}: PM2.5 {pm25:.0f}", action)
    return found
