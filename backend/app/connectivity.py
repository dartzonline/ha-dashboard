"""Internet outage detection from Home Assistant history.

No single entity reliably witnesses an outage, so this merges several weaker
signals into one timeline:

* A connectivity `binary_sensor` (e.g. the Orbi's WAN status) going `off`.
* `unavailable`/`unknown` on those sensors, which is what actually happens
  when the integration itself loses contact -- distinct from a clean `off`.
* Gaps in a fast-polling numeric sensor's history. If the router publishes a
  throughput reading every 30s and then says nothing for ten minutes, either
  it or the network was down, whatever the WAN sensor claims. This is the only
  signal that survives Home Assistant losing contact with the router entirely.
* External-IP changes, which prove the WAN session dropped and reconnected
  even when every sensor above missed the transition.

Detection floor, and it is a real one: the Orbi is polled every ~30 seconds
(measured: median 30.0s, p99 42s), so a drop shorter than that can pass
entirely between two readings and leave no trace in any of the signals above.
Nothing here can recover it. Outages of roughly a minute or more are detected
reliably; anything shorter is invisible, which is why the API reports the
resolution it actually achieved instead of implying second-level precision.
Installing Home Assistant's `ping` integration against an external host would
lower this floor, since it is event-driven rather than polled.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

# States that mean "this sensor is not reporting a healthy connection".
DOWN_STATES = {"off", "unavailable", "unknown", "disconnected"}

# A numeric sensor silent for longer than (its own cadence x this) is treated as
# an outage. Generous enough that one skipped poll or a slow scrape is not
# mistaken for a drop.
GAP_TOLERANCE = 4.0

# Never infer an outage from a gap shorter than this, regardless of cadence --
# below it the evidence is one missed poll, which happens routinely.
MIN_GAP_OUTAGE_S = 90.0

# Outages closer together than this are merged. A flapping link produces a
# burst of transitions that are really one event to a person reading the board.
MERGE_WITHIN_S = 30.0

# Anything shorter than this is reported as a "blip" rather than an outage: it
# is real, but counting a 0.4s drop the same as a 20-minute one would be
# misleading.
BLIP_MAX_S = 5.0

# Trailing silence longer than this is treated as the end of the recorder's
# retained history rather than a live outage. A genuine ongoing outage is
# noticed within a poll or two; six days of silence is missing data.
TRAILING_OUTAGE_MAX_S = 900.0


def parse_point(row: dict[str, Any]) -> tuple[float, str] | None:
    """(epoch_seconds, state) from one Home Assistant history row."""
    stamp = row.get("last_changed") or row.get("last_updated")
    if not isinstance(stamp, str):
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp(), str(row.get("state", ""))


def _sorted_points(rows: Iterable[dict[str, Any]]) -> list[tuple[float, str]]:
    points = [point for point in (parse_point(row) for row in rows) if point]
    points.sort(key=lambda item: item[0])
    return points


def outages_from_binary(rows: Iterable[dict[str, Any]], now: float, source: str) -> list[dict[str, Any]]:
    """Spans where a connectivity sensor reported a down state.

    An outage still open at `now` is returned with `ongoing` set rather than a
    fabricated end, so the caller can show it as in-progress.
    """
    points = _sorted_points(rows)
    spans: list[dict[str, Any]] = []
    started: float | None = None
    for moment, state in points:
        is_down = state.lower() in DOWN_STATES
        if is_down and started is None:
            started = moment
        elif not is_down and started is not None:
            spans.append({"start": started, "end": moment, "source": source, "ongoing": False})
            started = None
    if started is not None:
        spans.append({"start": started, "end": now, "source": source, "ongoing": True})
    return spans


def outages_from_gaps(rows: Iterable[dict[str, Any]], now: float, source: str) -> list[dict[str, Any]]:
    """Spans where a regularly-polled numeric sensor went silent.

    The threshold is derived from the sensor's own median interval rather than
    hard-coded, so this works whether the entity updates every 30 seconds or
    every five minutes.
    """
    points = _sorted_points(rows)
    if len(points) < 3:
        return []

    stamps = [moment for moment, _ in points]
    deltas = sorted(stamps[index + 1] - stamps[index] for index in range(len(stamps) - 1))
    median = deltas[len(deltas) // 2]
    if median <= 0:
        return []
    threshold = max(MIN_GAP_OUTAGE_S, median * GAP_TOLERANCE)

    spans: list[dict[str, Any]] = []
    for index in range(len(stamps) - 1):
        gap = stamps[index + 1] - stamps[index]
        if gap >= threshold:
            spans.append({
                "start": stamps[index],
                "end": stamps[index + 1],
                "source": source,
                "ongoing": False,
            })

    # Silence that runs to the present *may* be an outage in progress -- but it
    # is equally what the end of the recorder's retention looks like. Home
    # Assistant answers a 7-day history request with only the ~24h it actually
    # kept, and reading that absence as a live outage reported "uptime 14%,
    # ongoing" on a connection that was fine. Only trust it when the silence is
    # recent enough to really be happening now; older silence is missing data,
    # which `data_coverage` reports separately instead.
    trailing = now - stamps[-1]
    if threshold <= trailing <= max(threshold * 4, TRAILING_OUTAGE_MAX_S):
        spans.append({"start": stamps[-1], "end": now, "source": source, "ongoing": True})
    return spans


def data_coverage(rows: Iterable[dict[str, Any]], window_start: float, now: float) -> tuple[float, float]:
    """(covered_start, covered_end) -- the span this entity actually has data for.

    Uptime has to be measured against the time genuinely observed, not the time
    requested: the recorder keeps far less history than the dashboard may ask
    for, and dividing by the requested window would understate uptime badly.
    """
    stamps = [moment for moment, _ in _sorted_points(rows)]
    if not stamps:
        return window_start, now
    return max(window_start, min(stamps)), min(now, max(stamps[-1], min(stamps)))


def ip_changes(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Moments the external IP changed -- proof the WAN session reconnected.

    Not an outage span (the drop's duration is unknowable from this alone), but
    strong evidence one happened, and worth showing when nothing else caught it.
    """
    points = _sorted_points(rows)
    changes: list[dict[str, Any]] = []
    previous: str | None = None
    for moment, state in points:
        value = state.strip()
        # `0.0.0.0` is what the router reports mid-reconnect, not an address it
        # was ever reachable on. Treating it as one turns a single ISP reconnect
        # into two "IP changes" and shows a meaningless address in the log.
        if not value or value.lower() in DOWN_STATES or value in ("0.0.0.0", "::"):
            continue
        if previous is not None and value != previous:
            changes.append({"at": moment, "from": previous, "to": value})
        previous = value
    return changes


def merge_spans(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse overlapping/adjacent spans, keeping every contributing source.

    The same outage is usually seen by more than one signal at slightly
    different times (a polled sensor notices late, a ping sensor immediately),
    so without merging one drop would be counted several times.
    """
    if not spans:
        return []
    ordered = sorted(spans, key=lambda span: span["start"])
    merged = [dict(ordered[0], sources={ordered[0]["source"]})]
    for span in ordered[1:]:
        current = merged[-1]
        if span["start"] - current["end"] <= MERGE_WITHIN_S:
            current["end"] = max(current["end"], span["end"])
            current["ongoing"] = current["ongoing"] or span["ongoing"]
            current["sources"].add(span["source"])
        else:
            merged.append(dict(span, sources={span["source"]}))
    for span in merged:
        span.pop("source", None)
        span["sources"] = sorted(span["sources"])
    return merged


def poll_interval(rows: Iterable[dict[str, Any]]) -> float | None:
    """Median seconds between readings -- the finest outage this data can show.

    Surfaced to the caller so the UI can say "resolution ~30s" rather than
    implying it would have caught a two-second drop.
    """
    stamps = [moment for moment, _ in _sorted_points(rows)]
    if len(stamps) < 3:
        return None
    deltas = sorted(stamps[index + 1] - stamps[index] for index in range(len(stamps) - 1))
    median = deltas[len(deltas) // 2]
    return round(median, 1) if median > 0 else None


def summarize(
    spans: list[dict[str, Any]],
    window_start: float,
    now: float,
    ip_events: list[dict[str, Any]] | None = None,
    resolution_seconds: float | None = None,
    observed_start: float | None = None,
) -> dict[str, Any]:
    """Uptime percentage, counts, and a serialisable outage list.

    `observed_start` is when usable history actually begins. Uptime is measured
    against the time genuinely observed rather than the time requested -- Home
    Assistant's recorder keeps far less than a week, so dividing a 30-second
    outage by a requested 7-day window (most of which has no data at all) is
    what produced a nonsense "14% uptime" reading.
    """
    measured_from = max(window_start, observed_start if observed_start is not None else window_start)
    clipped: list[dict[str, Any]] = []
    for span in spans:
        start = max(span["start"], measured_from)
        end = min(span["end"], now)
        if end <= start:
            continue
        clipped.append({**span, "start": start, "end": end})

    total_down = sum(span["end"] - span["start"] for span in clipped)
    window = max(1.0, now - measured_from)
    # An outage cannot exceed the window; clamping keeps a partially-covered
    # window from reporting a negative uptime.
    uptime = max(0.0, min(100.0, (1 - total_down / window) * 100))

    def iso(value: float) -> str:
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")

    events = [
        {
            "start": iso(span["start"]),
            "end": iso(span["end"]),
            "seconds": round(span["end"] - span["start"], 1),
            "ongoing": bool(span["ongoing"]),
            "blip": (span["end"] - span["start"]) <= BLIP_MAX_S,
            "sources": span["sources"],
        }
        for span in sorted(clipped, key=lambda item: item["start"], reverse=True)
    ]

    outages = [event for event in events if not event["blip"]]
    blips = [event for event in events if event["blip"]]

    return {
        "uptimePercent": round(uptime, 3),
        "downSeconds": round(total_down, 1),
        "outageCount": len(outages),
        "blipCount": len(blips),
        "longestSeconds": round(max((event["seconds"] for event in events), default=0.0), 1),
        "ongoing": any(event["ongoing"] for event in events),
        # How fine-grained this answer actually is. The router is polled, so a
        # drop shorter than this could have happened without being recorded --
        # the UI says so rather than implying second-level certainty.
        "resolutionSeconds": resolution_seconds,
        # Hours of history genuinely behind these numbers, which is usually far
        # less than the hours requested because of the recorder's retention.
        "observedHours": round(window / 3600, 2),
        "events": events[:20],
        "ipChanges": [
            {"at": iso(change["at"]), "from": change["from"], "to": change["to"]}
            for change in sorted(ip_events or [], key=lambda item: item["at"], reverse=True)
        ][:10],
    }
