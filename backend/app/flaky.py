"""Devices that keep dropping off: Wi-Fi clients that leave and rejoin, and gear that goes
unavailable, counted over a week of history.

A Home Assistant restart makes every entity unavailable in the same instant, which is not any one
device's fault -- those moments are removed before counting. What is left is the device that
disconnects 27 times a day, or the projector that goes unavailable every night at 3 am.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, tzinfo
from typing import Any, Iterable

from . import connectivity

DEAD = {"unavailable", "unknown"}
RESTART_BURST_MIN = 8
MIN_DROPOUTS = 6
FLAKY_DOMAINS = {
    "device_tracker", "media_player", "vacuum", "climate", "fan", "lock", "cover", "light", "switch",
}


def watched(entity: dict[str, Any]) -> bool:
    """Entities whose history is worth reading for dropouts."""
    entity_id = str(entity.get("entity_id", ""))
    domain = entity_id.split(".", 1)[0]
    if domain in FLAKY_DOMAINS:
        return True
    return domain == "binary_sensor" and (entity.get("attributes") or {}).get("device_class") == "connectivity"


def dropout_times(rows: Iterable[dict[str, Any]], tracker: bool) -> list[float]:
    times: list[float] = []
    previous: str | None = None
    for row in rows:
        parsed = connectivity.parse_point(row)
        if not parsed:
            continue
        moment, state = parsed
        if previous is not None:
            if tracker and previous == "home" and state == "not_home":
                times.append(moment)
            elif not tracker and previous not in DEAD and state in DEAD:
                times.append(moment)
        previous = state
    return times


def flaky_devices(
    series: list[list[dict[str, Any]]], states: dict[str, dict[str, Any]], zone: tzinfo, now: float, days: int,
) -> list[dict[str, Any]]:
    per_entity: dict[str, list[float]] = {}
    for rows in series:
        if not rows:
            continue
        entity_id = str(rows[0].get("entity_id", ""))
        if not entity_id:
            continue
        per_entity[entity_id] = dropout_times(rows, entity_id.startswith("device_tracker."))

    # The same minute across many devices is Home Assistant (or the router) restarting.
    crowd: Counter[int] = Counter()
    for times in per_entity.values():
        for minute in {int(moment // 60) for moment in times}:
            crowd[minute] += 1
    devices = []
    for entity_id, times in per_entity.items():
        real = [moment for moment in times if crowd[int(moment // 60)] < RESTART_BURST_MIN]
        if len(real) < MIN_DROPOUTS:
            continue
        entity = states.get(entity_id, {})
        attributes = entity.get("attributes") or {}
        hours = Counter(datetime.fromtimestamp(moment, zone).hour for moment in real)
        busiest, in_busiest = hours.most_common(1)[0]
        devices.append({
            "entityId": entity_id,
            "name": attributes.get("friendly_name") or entity_id,
            "dropouts": len(real),
            "perDay": round(len(real) / max(1, days), 1),
            "lastAt": datetime.fromtimestamp(max(real), zone).astimezone().isoformat(),
            # Only worth saying when it clusters: at least a third of drops in one hour of the day.
            "usualHour": busiest if in_busiest / len(real) >= 1 / 3 and len(real) >= 8 else None,
            "ip": attributes.get("ip"),
            "mac": attributes.get("mac"),
            "hostname": attributes.get("host_name"),
            "kind": "wifi" if entity_id.startswith("device_tracker.") else "device",
            "now": entity.get("state"),
        })
    devices.sort(key=lambda item: -item["dropouts"])
    return devices

