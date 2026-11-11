"""How the garage door opener is ageing: how long the door takes to travel, and whether it is
slowing down or reversing.

The opener's own "opening duration" setting is a number somebody typed in; the *measured* travel
time is the gap between the cover reading `opening` and then `open` (and `closing` then `closed`).
A door that takes noticeably longer than it did a week ago has a developing spring, roller or
opener problem, and one that keeps reversing mid-close has a sensor or an obstruction.
"""

from __future__ import annotations

import statistics
from typing import Any, Iterable

from . import connectivity

MAX_TRAVEL_S = 120.0
MIN_SAMPLES = 5
DRIFT_PERCENT = 15.0
DRIFT_SECONDS = 2.0


def travels(rows: Iterable[dict[str, Any]]) -> dict[str, list[tuple[float, float]]]:
    """(finished at, seconds) for each clean opening and closing, plus reversals."""
    out: dict[str, list[tuple[float, float]]] = {"opening": [], "closing": [], "reversals": []}
    started: tuple[str, float] | None = None
    for row in rows:
        parsed = connectivity.parse_point(row)
        if not parsed:
            continue
        moment, state = parsed
        if state in ("opening", "closing"):
            if started is not None and started[0] == "closing" and state == "opening":
                out["reversals"].append((moment, 0.0))
            started = (state, moment)
        elif state == "open" and started and started[0] == "opening":
            seconds = moment - started[1]
            if 0 < seconds <= MAX_TRAVEL_S:
                out["opening"].append((moment, seconds))
            started = None
        elif state == "closed" and started and started[0] == "closing":
            seconds = moment - started[1]
            if 0 < seconds <= MAX_TRAVEL_S:
                out["closing"].append((moment, seconds))
            started = None
        elif state in ("open", "closed", "stopped"):
            started = None
    return out


def _drift(samples: list[tuple[float, float]], now: float) -> dict[str, Any] | None:
    week = 7 * 86400.0
    recent = [seconds for moment, seconds in samples if now - moment <= week]
    earlier = [seconds for moment, seconds in samples if week < now - moment <= 2 * week]
    if len(recent) < MIN_SAMPLES:
        return None
    result: dict[str, Any] = {
        "seconds": round(statistics.median(recent), 1), "samples": len(recent), "previous": None, "change": None, "slowing": False,
    }
    if len(earlier) >= MIN_SAMPLES:
        before = statistics.median(earlier)
        change = statistics.median(recent) - before
        result["previous"] = round(before, 1)
        result["change"] = round(change, 1)
        result["slowing"] = change >= DRIFT_SECONDS and before > 0 and change / before * 100 >= DRIFT_PERCENT
    return result


def opener_health(rows: Iterable[dict[str, Any]], now: float) -> dict[str, Any]:
    found = travels(rows)
    week = 7 * 86400.0
    return {
        "opening": _drift(found["opening"], now),
        "closing": _drift(found["closing"], now),
        "reversals": sum(1 for moment, _ in found["reversals"] if now - moment <= week),
        "trips": sum(1 for moment, _ in found["opening"] if now - moment <= week),
    }
