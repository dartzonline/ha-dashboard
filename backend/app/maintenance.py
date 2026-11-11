"""Upkeep: what is wearing out, what is running out, and what is drifting.

Distinct from `home_health`, which answers "is anything broken right now".
This answers "what will need me soon", which is a different and quieter class
of signal -- the kind nobody notices until a filter has been at 0% for weeks.

Three kinds of thing are gathered:

* **Consumables.** Filters, brushes and strainers, reported by their devices in
  wildly different units: Roborock counts down *hours remaining*, LG and Dyson
  report *percent of life left*. Both are normalised to a fraction so one panel
  can rank them against each other.
* **Reservoirs.** Salt and water levels, which deplete rather than wear.
* **Mechanical drift.** A garage door's opening and closing durations are a
  genuine predictive-maintenance signal: a door that takes longer to travel
  than it used to has a spring, chain or roller problem developing. Nothing in
  Home Assistant watches that number for change.

Where a device publishes an explicit fault flag it is trusted over any derived
figure, because the device knows things a percentage cannot express.
"""

from __future__ import annotations

from typing import Any, Iterable

DEAD_STATES = {"unavailable", "unknown"}

# homeassistant.components.update.const.UpdateEntityFeature.INSTALL -- the bit an update entity
# sets when `update.install` actually works for it. A handful of integrations publish an update
# entity that is read-only (informational only, installed some other way), and offering an
# Install button that would just fail is worse than not offering one.
UPDATE_INSTALL_FEATURE = 1

# Roborock publishes hours remaining rather than a percentage, so a full service
# interval is needed to express it as a fraction. These are the manufacturer's
# published intervals -- the device does not report them, so the UI says the
# percentages are derived rather than device-reported.
SERVICE_INTERVAL_HOURS = {
    "main_brush": 300.0,
    "side_brush": 200.0,
    "filter": 150.0,
    "sensor": 30.0,
    "dock_strainer": 90.0,
    "dock_maintenance_brush": 300.0,
}

# Below this fraction of life remaining a consumable is worth ordering.
CONSUMABLE_WARN = 0.20
CONSUMABLE_CRITICAL = 0.05

# Salt depth: an empty brine tank reads a *larger* distance because the sensor
# looks down at the salt from above. Calibrated from the observed range on this
# install rather than assumed, and used only as a fallback when the device's own
# percentage is untrustworthy (see `salt_status`).
SALT_FULL_CM = 15.0
SALT_EMPTY_CM = 55.0


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return str(attributes.get("friendly_name") or entity.get("entity_id") or "")


def _unit(entity: dict[str, Any]) -> str:
    return str((entity.get("attributes") or {}).get("unit_of_measurement") or "")


def _index(states: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(entity.get("entity_id", "")): entity for entity in states}


def _severity(fraction: float | None, fault: bool = False) -> str:
    if fault:
        return "critical"
    if fraction is None:
        return "unknown"
    if fraction <= CONSUMABLE_CRITICAL:
        return "critical"
    if fraction <= CONSUMABLE_WARN:
        return "warning"
    return "ok"


def _interval_for(entity_id: str) -> float | None:
    # Longest key first so "dock_maintenance_brush" is not matched by "brush".
    for key in sorted(SERVICE_INTERVAL_HOURS, key=len, reverse=True):
        if key in entity_id:
            return SERVICE_INTERVAL_HOURS[key]
    return None


# Wear items are named inconsistently. "_time_left" is the catch-all that picks
# up the vacuum's dust-sensor consumable, whose id contains none of the words
# below -- it was silently dropped, and it is the one item on this install
# actually past its service interval.
CONSUMABLE_HINTS = ("filter", "brush", "strainer", "consumable", "cartridge", "time_left")


def consumables(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every wear item, normalised to a fraction of life remaining.

    Two shapes are handled because devices disagree: a percentage is already a
    fraction of life, while hours-remaining needs dividing by a service
    interval. An item whose device also exposes a "replace me" flag inherits
    that flag, since the device is more authoritative than either number.
    """
    states = list(states)
    replacement_flags = {
        str(entity.get("entity_id", "")): entity.get("state") == "on"
        for entity in states
        if str(entity.get("entity_id", "")).startswith("binary_sensor.")
        and ("filter_replacement" in str(entity.get("entity_id", "")) or "replace" in str(entity.get("entity_id", "")))
    }
    any_replacement_due = any(replacement_flags.values())

    found: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("sensor.") or entity.get("state") in DEAD_STATES:
            continue
        if not any(hint in entity_id.lower() for hint in CONSUMABLE_HINTS):
            continue
        # "_filter_type" is the cartridge model, not its life.
        if entity_id.endswith("_type") or "_type_" in entity_id:
            continue
        value = _number(entity.get("state"))
        if value is None:
            continue

        unit = _unit(entity)
        fraction: float | None = None
        remaining_hours: float | None = None
        if unit == "%":
            fraction = max(0.0, min(1.0, value / 100))
        elif unit == "h":
            remaining_hours = value
            interval = _interval_for(entity_id)
            if interval:
                # A negative remainder means the interval has been exceeded, which
                # is a real state ("overdue") rather than something to clamp away
                # silently -- the fraction floors at 0 but `overdue` records it.
                fraction = max(0.0, min(1.0, value / interval))
        else:
            continue

        device_flagged = any_replacement_due and "dyson" in entity_id and fraction is not None and fraction <= CONSUMABLE_WARN
        found.append({
            "entityId": entity_id,
            "name": _name(entity),
            "fraction": round(fraction, 4) if fraction is not None else None,
            "percent": round(fraction * 100, 1) if fraction is not None else None,
            "remainingHours": round(remaining_hours, 1) if remaining_hours is not None else None,
            "overdue": bool(remaining_hours is not None and remaining_hours <= 0),
            "derived": unit == "h",
            "severity": _severity(fraction, fault=device_flagged or bool(remaining_hours is not None and remaining_hours <= 0)),
        })

    order = {"critical": 0, "warning": 1, "unknown": 2, "ok": 3}
    found.sort(key=lambda item: (order.get(str(item["severity"]), 9), item["fraction"] if item["fraction"] is not None else 1.0))
    return found


def salt_status(states: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Water-softener salt, preferring the depth reading over the percentage.

    The percentage on this install collapsed from 60% to 0% while the depth
    sensor barely moved (43.5cm to 42.1cm), so the percentage is a calibration
    artefact and trusting it would show a false "refill now". Depth is the raw
    measurement and is used whenever the two disagree materially; the
    disagreement is reported so the sensor can be fixed rather than silently
    worked around.
    """
    index = _index(states)
    depth_entity = index.get("sensor.esphome_web_79cc76_salt_level")
    percent_entity = index.get("sensor.esphome_web_79cc76_salt_level_percent")
    if not depth_entity and not percent_entity:
        # The sensor's entities vanish when its ESPHome device stops answering; anything else still
        # named for salt (its automation, its network sensor) says there should be one.
        if any("salt" in str(entity.get("entity_id", "")) for entity in index.values()):
            return {
                "depthCm": None, "reportedPercent": None, "percent": None, "fromDepth": False,
                "sensorDisagrees": False, "sensorFault": True, "offline": True, "severity": "unknown",
            }
        return None

    # The depth reading is the real measurement. When it is missing, the percentage Home Assistant
    # derives from it falls to 0% -- an empty tank that is not empty. Say the sensor is not reading.
    # (A plausible percentage with the depth missing is still used, below.)
    reported_now = _number((percent_entity or {}).get("state")) if percent_entity else None
    if depth_entity is not None and depth_entity.get("state") in DEAD_STATES and (reported_now is None or reported_now <= 0):
        return {
            "depthCm": None,
            "reportedPercent": None,
            "percent": None,
            "fromDepth": False,
            "sensorDisagrees": False,
            "sensorFault": True,
            "severity": "unknown",
        }

    depth_cm = _number((depth_entity or {}).get("state")) if depth_entity and depth_entity.get("state") not in DEAD_STATES else None
    reported = _number((percent_entity or {}).get("state")) if percent_entity and percent_entity.get("state") not in DEAD_STATES else None

    from_depth: float | None = None
    if depth_cm is not None:
        span = SALT_EMPTY_CM - SALT_FULL_CM
        if span > 0:
            from_depth = max(0.0, min(100.0, (1 - (depth_cm - SALT_FULL_CM) / span) * 100))

    percent = from_depth if from_depth is not None else reported
    disagrees = (
        from_depth is not None and reported is not None and abs(from_depth - reported) >= 25
    )

    return {
        "depthCm": round(depth_cm, 1) if depth_cm is not None else None,
        "reportedPercent": round(reported, 1) if reported is not None else None,
        "percent": round(percent, 1) if percent is not None else None,
        "fromDepth": from_depth is not None,
        "sensorDisagrees": disagrees,
        "sensorFault": False,
        "severity": _severity((percent / 100) if percent is not None else None),
    }


def garage_status(states: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Garage door position, obstruction, and travel-time wear signal.

    Travel duration is the interesting number: a door that gradually takes
    longer to open than it used to has a developing spring or roller problem.
    Home Assistant stores the value but nothing watches it for drift, so it is
    surfaced here with its history left to the caller to chart.
    """
    index = _index(states)
    door = index.get("cover.ratgdov25i_8e54c8_door")
    if not door:
        return None

    def value(entity_id: str) -> float | None:
        entity = index.get(entity_id)
        if not entity or entity.get("state") in DEAD_STATES:
            return None
        return _number(entity.get("state"))

    obstruction = index.get("binary_sensor.ratgdov25i_8e54c8_obstruction")
    firmware = index.get("sensor.ratgdov25i_8e54c8_firmware_version")

    return {
        "entityId": door.get("entity_id"),
        "state": door.get("state"),
        "obstructed": bool(obstruction and obstruction.get("state") == "on"),
        "openingSeconds": value("number.ratgdov25i_8e54c8_opening_duration"),
        "closingSeconds": value("number.ratgdov25i_8e54c8_closing_duration"),
        "openLimit": (index.get("binary_sensor.ratgdov25i_8e54c8_open_limit_switch") or {}).get("state"),
        "closeLimit": (index.get("binary_sensor.ratgdov25i_8e54c8_close_limit_switch") or {}).get("state"),
        "firmware": (firmware or {}).get("state"),
        "durationEntities": [
            "number.ratgdov25i_8e54c8_opening_duration",
            "number.ratgdov25i_8e54c8_closing_duration",
        ],
    }


def device_faults(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Explicit fault flags a device is raising about itself.

    Many integrations publish a fan-out of `fault_*` binary sensors that are
    almost always `off` and therefore invisible; when one does trip it deserves
    to be the loudest thing on the page.
    """
    faults: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("binary_sensor."):
            continue
        if entity.get("state") != "on":
            continue
        device_class = str((entity.get("attributes") or {}).get("device_class") or "")
        is_fault_name = "fault" in entity_id or "error" in entity_id
        if device_class != "problem" and not is_fault_name:
            continue
        faults.append({
            "entityId": entity_id,
            "name": _name(entity),
        })
    faults.sort(key=lambda item: str(item["entityId"]))
    return faults


def appliance_usage(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cycle counts and month-over-month energy, as a proxy for wear and drift.

    A month's energy well above the previous one on an appliance that is not
    being used more often is worth noticing -- a fridge working harder is often
    a door seal or a coil problem.
    """
    index = _index(states)
    devices: dict[str, dict[str, Any]] = {}

    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("sensor.") or entity.get("state") in DEAD_STATES:
            continue
        for suffix, key in (
            ("_energy_this_month", "thisMonthWh"),
            ("_energy_last_month", "lastMonthWh"),
            ("_cycles", "cycles"),
        ):
            if entity_id.endswith(suffix):
                device = entity_id[len("sensor."):-len(suffix)]
                value = _number(entity.get("state"))
                if value is None:
                    continue
                slot = devices.setdefault(device, {"device": device, "name": device.replace("_", " ").title()})
                slot[key] = value
                slot.setdefault("entityIds", []).append(entity_id)

    results: list[dict[str, Any]] = []
    for slot in devices.values():
        this_month = slot.get("thisMonthWh")
        last_month = slot.get("lastMonthWh")
        change: float | None = None
        # Only meaningful once the previous month has a real total to compare to,
        # and pointless in the first days of a month when this month is tiny.
        if this_month is not None and last_month not in (None, 0):
            change = round(((this_month - float(last_month)) / float(last_month)) * 100, 1)
        status_entity = index.get(f"sensor.{slot['device']}_current_status")
        results.append({
            **slot,
            "changePercent": change,
            "status": (status_entity or {}).get("state"),
        })

    results.sort(key=lambda item: str(item["name"]))
    return results


def software_updates(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pending updates Home Assistant's own `update.*` entities already know about.

    Home Assistant Core/Supervisor/OS always publish one of these when running as an add-on, and
    any integration can add its own -- ESPHome device firmware, HACS-installed components, and so
    on. Nothing here is guessed or version-compared by this app: `state == "on"` is the entity's
    own conclusion that a newer version exists, arrived at (and kept current) by Home Assistant
    itself, including not re-nagging about a version the user already skipped -- HA reports that
    case as `"off"` too, so there is nothing left for this function to second-guess.
    """
    updates: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("update.") or entity.get("state") != "on":
            continue
        attributes = entity.get("attributes") or {}
        features = attributes.get("supported_features")
        in_progress = attributes.get("in_progress")
        percent = attributes.get("update_percentage")
        updates.append({
            "entityId": entity_id,
            # `title` is the device/integration's own name for itself (e.g. "Home Assistant Core");
            # friendly_name on these entities is often just "<title> Update" and reads redundantly
            # once it is already under an "Updates available" heading.
            "name": str(attributes.get("title") or _name(entity)),
            "installedVersion": attributes.get("installed_version"),
            "latestVersion": attributes.get("latest_version"),
            "releaseSummary": attributes.get("release_summary"),
            "releaseUrl": attributes.get("release_url"),
            "canInstall": isinstance(features, int) and bool(features & UPDATE_INSTALL_FEATURE),
            "inProgress": bool(in_progress),
            "progressPercent": percent if isinstance(percent, (int, float)) else None,
        })

    updates.sort(key=lambda item: str(item["name"]))
    return updates


def maintenance_summary(states: Iterable[dict[str, Any]]) -> dict[str, Any]:
    states = list(states)
    items = consumables(states)
    return {
        "consumables": items,
        "salt": salt_status(states),
        "garage": garage_status(states),
        "faults": device_faults(states),
        "appliances": appliance_usage(states),
        "updates": software_updates(states),
        "counts": {
            "critical": sum(1 for item in items if item["severity"] == "critical"),
            "warning": sum(1 for item in items if item["severity"] == "warning"),
            "ok": sum(1 for item in items if item["severity"] == "ok"),
        },
    }


REPLACE_AT = 0.15
# Wear items that are cleaned rather than bought (a vacuum's cliff sensors, the dock strainer).
CLEAN_ONLY_PARTS = ("sensor_time_left", "strainer")
SALT_LOW_PERCENT = 25.0
SALT_SOON_DAYS = 14.0


def replace_now(states: Iterable[dict[str, Any]], salt_forecast: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Everything to replace, refill or check now: worn filters and brushes, salt, and a salt
    sensor that has stopped reading. Each item names what to buy, for the shopping list."""
    states = list(states)
    items: list[dict[str, Any]] = []
    for item in consumables(states):
        fraction = item["fraction"]
        if not item["overdue"] and (fraction is None or fraction > REPLACE_AT):
            continue
        name = str(item["name"])
        detail = (
            f"Overdue by {abs(item['remainingHours']):.0f} h" if item["overdue"] and item["remainingHours"] is not None
            else f"{item['percent']:.0f}% left"
        )
        clean_only = any(part in str(item["entityId"]) for part in CLEAN_ONLY_PARTS)
        items.append({
            "id": item["entityId"],
            "kind": "clean" if clean_only else "consumable",
            "title": f"Clean: {_shopping_name(name)}" if clean_only else _shopping_name(name),
            "detail": detail,
            "severity": "critical" if item["overdue"] or (fraction is not None and fraction <= 0.05) else "warning",
            "buy": None if clean_only else _shopping_name(name),
        })

    salt = salt_status(states)
    if salt is not None:
        if salt.get("sensorFault"):
            items.append({
                "id": "salt-sensor", "kind": "fault",
                "title": "Salt sensor offline" if salt.get("offline") else "Salt sensor not reading",
                "detail": (
                    "Home Assistant has lost the softener's salt sensor. Check it has power and Wi-Fi."
                    if salt.get("offline")
                    else "The 0% is not real. Check the sensor in the softener lid is seated and pointing at the salt."
                ),
                "severity": "warning", "buy": None,
            })
        elif salt.get("percent") is not None and salt["percent"] <= SALT_LOW_PERCENT:
            items.append({
                "id": "salt", "kind": "salt", "title": "Water softener salt",
                "detail": f"{salt['percent']:.0f}% left", "severity": "critical" if salt["percent"] <= 10 else "warning",
                "buy": "Water softener salt",
            })
        elif salt_forecast and salt_forecast.get("daysToLow") is not None and salt_forecast["daysToLow"] <= SALT_SOON_DAYS:
            items.append({
                "id": "salt", "kind": "salt", "title": "Water softener salt",
                "detail": f"Runs low in about {salt_forecast['daysToLow']:.0f} days (around {salt_forecast['lowOn']})",
                "severity": "info", "buy": "Water softener salt",
            })
    order = {"critical": 0, "warning": 1, "info": 2}
    items.sort(key=lambda entry: order.get(entry["severity"], 9))
    return items


def _shopping_name(name: str) -> str:
    """"Dyson 3WF-US-UGF5956A Carbon Filter Life" reads better on a list as "Dyson Carbon Filter"."""
    words = [word for word in name.replace("_", " ").split() if not any(char.isdigit() for char in word) or len(word) < 4]
    cleaned = " ".join(word for word in words if word.lower() not in ("life", "time", "left", "remaining"))
    return cleaned or name
