"""Water-softener salt over time: refills noticed, and a warning before it runs low.

The salt sensor reports a level, not a trend. This keeps a reading every six hours, notices a
refill as a jump of 15 points or more, and fits a straight line to the readings since the last
refill to say when the tank will reach 20% -- so "buy salt" comes about ten days ahead rather
than on the day it is empty.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .atomic import write_text_atomic

logger = logging.getLogger(__name__)

DAY = 86400.0
SAMPLE_EVERY_S = 6 * 3600.0
REFILL_JUMP = 15.0
LOW_PERCENT = 20.0
WARN_DAYS = 10.0
MIN_SPAN_DAYS = 3.0
KEEP_S = 180 * DAY


class SaltWatch:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self.samples: list[dict[str, float]] = []
        self.refills: list[dict[str, float]] = []
        if path is not None and path.is_file():
            try:
                stored = json.loads(path.read_text())
                self.samples = [item for item in stored.get("samples", []) if isinstance(item, dict)]
                self.refills = [item for item in stored.get("refills", []) if isinstance(item, dict)]
            except (OSError, ValueError, AttributeError) as error:
                logger.warning("Could not read the salt log: %s", error)

    def record(self, percent: float | None, now: float | None = None) -> bool:
        """Adds a reading if one is due. Returns True when a refill was just noticed."""
        moment = now if now is not None else time.time()
        if percent is None:
            return False
        last = self.samples[-1] if self.samples else None
        refilled = last is not None and percent - last["percent"] >= REFILL_JUMP
        if last is not None and not refilled and moment - last["at"] < SAMPLE_EVERY_S:
            return False
        if refilled:
            self.refills.append({"at": moment, "from": last["percent"], "to": percent})
        self.samples.append({"at": moment, "percent": round(percent, 1)})
        cutoff = moment - KEEP_S
        self.samples = [item for item in self.samples if item["at"] >= cutoff]
        self.refills = [item for item in self.refills if item["at"] >= cutoff]
        self._save()
        return refilled

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            write_text_atomic(self._path, json.dumps({"samples": self.samples, "refills": self.refills}))
        except OSError as error:
            logger.warning("Could not save the salt log: %s", error)

    def forecast(self, now: float | None = None) -> dict[str, Any]:
        """Usage per day since the last refill, and when the tank reaches 20% at that pace."""
        moment = now if now is not None else time.time()
        last_refill = self.refills[-1] if self.refills else None
        since = last_refill["at"] if last_refill else 0.0
        points = [item for item in self.samples if item["at"] >= since]
        result: dict[str, Any] = {
            "percent": self.samples[-1]["percent"] if self.samples else None,
            "perDay": None,
            "daysToLow": None,
            "lowOn": None,
            "lastRefill": _iso(last_refill["at"]) if last_refill else None,
            "refilledTo": last_refill["to"] if last_refill else None,
        }
        if len(points) < 3 or (points[-1]["at"] - points[0]["at"]) / DAY < MIN_SPAN_DAYS:
            return result
        days = [(item["at"] - points[0]["at"]) / DAY for item in points]
        levels = [item["percent"] for item in points]
        mean_x, mean_y = sum(days) / len(days), sum(levels) / len(levels)
        spread = sum((x - mean_x) ** 2 for x in days)
        if spread == 0:
            return result
        slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(days, levels)) / spread
        result["perDay"] = round(-slope, 2)
        if slope >= -0.05:
            return result
        current = levels[-1]
        days_to_low = max(0.0, (current - LOW_PERCENT) / -slope)
        result["daysToLow"] = round(days_to_low, 1)
        result["lowOn"] = _iso(moment + days_to_low * DAY)[:10]
        return result


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
