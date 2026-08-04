"""Keyless fallback feeds for flight data, plus the quota discipline for the metered ones.

Every position lookup in `flights.py` used to go to OpenSky alone. Anonymous OpenSky answers
`429` freely, so the board emptied out whenever it did -- and because AirLabs was called once per
pinned flight on every poll, a metered key could be spent in a day. This module fixes both ends:

* Three community ADS-B feeds (adsb.lol, adsb.fi, airplanes.live) need no key at all and are
  tried in order when OpenSky comes up empty. They return *more* than OpenSky does -- aircraft
  registration and type come free with the position, which also saves an adsbdb lookup.
* Every metered or scraped source goes through `Budget`, which stops making calls before the
  quota is gone rather than after.

All three feeds document a 1 request/second limit and ask non-feeders not to poll heavily, so
`throttle()` spaces calls per host. Nothing here raises: callers get `None`/`[]` and fall through
to the next source, matching the degrade-to-empty contract in `flights.py`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

# ---------------------------------------------------------------------------
# Keyless ADS-B feeds
# ---------------------------------------------------------------------------

# Each entry: (name, point-URL template, callsign-URL template, hex-URL template). Tried in this
# order; the first one to answer with aircraft wins, so a single feed being down is invisible.
# adsb.fi's /api/v2 point endpoint is deprecated in favour of /api/v3, but v3 has no callsign or
# hex route, hence the mixed versions.
ADSB_FEEDS: list[tuple[str, str, str | None, str | None]] = [
    (
        "adsb.lol",
        "https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}",
        "https://api.adsb.lol/v2/callsign/{callsign}",
        "https://api.adsb.lol/v2/hex/{hex}",
    ),
    (
        "adsb.fi",
        "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}",
        "https://opendata.adsb.fi/api/v2/callsign/{callsign}",
        "https://opendata.adsb.fi/api/v2/hex/{hex}",
    ),
    (
        "airplanes.live",
        "https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}",
        "https://api.airplanes.live/v2/callsign/{callsign}",
        "https://api.airplanes.live/v2/hex/{hex}",
    ),
]

# Every feed caps the point/radius query at 250 nautical miles and rejects more.
MAX_FEED_RADIUS_NM = 250
KM_PER_NM = 1.852

# The documented limit on all three feeds is 1 request/second, and they explicitly ask
# non-feeders to be gentle. Spacing is per host, so one slow feed cannot stall the others.
MIN_REQUEST_SPACING_S = 1.1

_host_next_allowed: dict[str, float] = {}
_host_locks: dict[str, asyncio.Lock] = {}


def _host_lock(host: str) -> asyncio.Lock:
    lock = _host_locks.get(host)
    if lock is None:
        lock = asyncio.Lock()
        _host_locks[host] = lock
    return lock


async def throttle(url: str) -> None:
    """Hold until this host's minimum request spacing has elapsed.

    Held across the sleep rather than just around the bookkeeping, so concurrent callers queue
    behind each other instead of all reading the same timestamp and firing together.
    """
    host = urlsplit(url).netloc
    async with _host_lock(host):
        wait = _host_next_allowed.get(host, 0.0) - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _host_next_allowed[host] = time.monotonic() + MIN_REQUEST_SPACING_S


def _ft_to_m(value: Any) -> float | None:
    try:
        return float(value) / 3.28084
    except (TypeError, ValueError):
        return None


def _knots_to_mps(value: Any) -> float | None:
    try:
        return float(value) * 0.514444
    except (TypeError, ValueError):
        return None


def _fpm_to_mps(value: Any) -> float | None:
    try:
        return float(value) / 196.850394
    except (TypeError, ValueError):
        return None


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# OpenSky state-vector layout, which every consumer in flights.py already speaks.
STATE_VECTOR_WIDTH = 17


def state_row_from_feed(ac: dict[str, Any]) -> list[Any] | None:
    """Convert one community-feed aircraft record into an OpenSky state vector.

    Translating at the edge is what lets the fallback feeds drop in without touching the
    classification, corridor and route-progress logic downstream -- all of it indexes state
    vectors positionally.
    """
    icao24 = (ac.get("hex") or "").strip().lower().lstrip("~")
    if not icao24:
        return None

    # These feeds report a grounded aircraft as the string "ground" in place of an altitude,
    # which would read as a missing value rather than the fact that it has landed.
    raw_baro = ac.get("alt_baro")
    on_ground = isinstance(raw_baro, str) and raw_baro.strip().lower() == "ground"
    baro_m = None if on_ground else _ft_to_m(raw_baro)
    geo_m = None if on_ground else _ft_to_m(ac.get("alt_geom"))

    callsign = ac.get("flight")
    callsign = callsign.strip() if isinstance(callsign, str) and callsign.strip() else None

    row: list[Any] = [None] * STATE_VECTOR_WIDTH
    row[0] = icao24
    row[1] = callsign
    row[5] = _num(ac.get("lon"))
    row[6] = _num(ac.get("lat"))
    row[7] = baro_m
    row[8] = on_ground
    row[9] = _knots_to_mps(ac.get("gs"))
    row[10] = _num(ac.get("track"))
    row[11] = _fpm_to_mps(ac.get("baro_rate") if ac.get("baro_rate") is not None else ac.get("geom_rate"))
    row[13] = geo_m
    return row


def aircraft_info_from_feed(ac: dict[str, Any]) -> dict[str, Any] | None:
    """The registration/type that ride along with a community-feed position.

    adsbdb is a separate request per aircraft for exactly this, so reusing what the position
    query already returned removes that call for every aircraft the feeds cover.
    """
    reg = ac.get("r")
    icao_type = ac.get("t")
    described = ac.get("desc")
    if not (reg or icao_type or described):
        return None
    return {
        "registration": reg.strip() if isinstance(reg, str) else None,
        # `desc` ("BOEING 737 MAX 8") is what the classifier reads best; `t` ("B38M") is the
        # terse ICAO code and only stands in when the long form is absent.
        "type": described.strip() if isinstance(described, str) and described.strip() else (icao_type or None),
        "icao_type": icao_type.strip() if isinstance(icao_type, str) else None,
    }


def _records(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    # adsb.lol/v2 and adsb.fi/v3 use "ac"; adsb.fi/v2 uses "aircraft".
    raw = payload.get("ac")
    if raw is None:
        raw = payload.get("aircraft")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


async def _feed_get(client: httpx.AsyncClient, url: str, on_error: Any) -> list[dict[str, Any]]:
    await throttle(url)
    try:
        response = await client.get(url, timeout=12, headers={"Accept": "application/json"})
        response.raise_for_status()
        return _records(response.json())
    except (httpx.HTTPError, ValueError) as error:
        on_error(str(error))
        return []


async def feed_states_in_radius(
    client: httpx.AsyncClient, lat: float, lon: float, radius_km: float, on_error: Any
) -> tuple[list[list[Any]], list[dict[str, Any]], str | None]:
    """Aircraft near a point from the first community feed that answers.

    Returns (state rows, raw records, feed name) so the caller can both use the positions and
    harvest the registration/type that came with them.
    """
    nm = max(1, min(MAX_FEED_RADIUS_NM, round(radius_km / KM_PER_NM)))
    for name, point_url, _, _ in ADSB_FEEDS:
        records = await _feed_get(
            client,
            point_url.format(lat=round(lat, 4), lon=round(lon, 4), nm=nm),
            lambda detail, name=name: on_error(f"adsb:{name}", detail),
        )
        rows = [row for row in (state_row_from_feed(ac) for ac in records) if row]
        if rows:
            return rows, records, name
    return [], [], None


async def feed_lookup(
    client: httpx.AsyncClient, kind: str, value: str, on_error: Any
) -> tuple[list[Any] | None, dict[str, Any] | None, str | None]:
    """One aircraft by callsign or hex, from the first feed that has it.

    The callsign form is the reason this layer is worth having beyond redundancy: resolving a
    pinned flight against OpenSky means downloading the entire planet's state vector and scanning
    it, whereas these feeds answer a callsign directly.
    """
    for name, _, callsign_url, hex_url in ADSB_FEEDS:
        template = callsign_url if kind == "callsign" else hex_url
        if not template:
            continue
        url = template.format(callsign=value.upper(), hex=value.lower())
        records = await _feed_get(client, url, lambda detail, name=name: on_error(f"adsb:{name}", detail))
        for ac in records:
            row = state_row_from_feed(ac)
            if row:
                return row, ac, name
    return None, None, None


# ---------------------------------------------------------------------------
# Worldwide route lookup (keyless)
# ---------------------------------------------------------------------------

ADSB_LOL_ROUTE_URL = "https://api.adsb.lol/api/0/route/{callsign}"

# key: callsign -> (fetched_at, (origin, dest) | None)
_route_cache: dict[str, tuple[float, tuple[dict[str, Any], dict[str, Any]] | None]] = {}
ROUTE_TTL = 3600.0
ROUTE_MISS_TTL = 900.0


def _route_airport(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": raw.get("iata") or raw.get("icao"),
        "city": raw.get("location") or raw.get("name"),
        "country": raw.get("countryiso2"),
        "lat": _num(raw.get("lat")),
        "lon": _num(raw.get("lon")),
    }


async def route_with_coordinates(
    client: httpx.AsyncClient, callsign: str | None, on_error: Any
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """(origin, dest) with real coordinates for any callsign, from adsb.lol's route database.

    The local `AIRPORTS` table in flights.py only covers airports near home, so a long-haul or
    foreign endpoint had no coordinates and the route map and progress bar could not be drawn.
    This is keyless and worldwide, which closes that gap.
    """
    if not callsign:
        return None
    key = callsign.strip().upper()
    now = time.time()
    cached = _route_cache.get(key)
    if cached:
        ttl = ROUTE_TTL if cached[1] else ROUTE_MISS_TTL
        if now - cached[0] < ttl:
            return cached[1]

    url = ADSB_LOL_ROUTE_URL.format(callsign=key)
    await throttle(url)
    result: tuple[dict[str, Any], dict[str, Any]] | None = None
    try:
        response = await client.get(url, timeout=12, follow_redirects=True, headers={"Accept": "application/json"})
        if response.status_code == 200:
            payload = response.json()
            airports = payload.get("_airports") if isinstance(payload, dict) else None
            # Only a simple two-airport routing is usable; a multi-leg answer cannot be reduced
            # to one origin/destination pair without knowing which leg is airborne.
            if isinstance(airports, list) and len(airports) == 2 and all(isinstance(a, dict) for a in airports):
                result = (_route_airport(airports[0]), _route_airport(airports[1]))
    except (httpx.HTTPError, ValueError) as error:
        on_error("adsb:route", str(error))
        return None

    _route_cache[key] = (now, result)
    return result


# ---------------------------------------------------------------------------
# Daily budget for metered / scraped sources
# ---------------------------------------------------------------------------

# Home Assistant mounts /data as the add-on's persistent volume; the repo-local path is the
# Compose/native fallback. Persisting matters because an in-memory counter would reset the
# budget on every restart, which is precisely when a crash-loop would drain a quota.
_BUDGET_DIR = Path("/data") if Path("/data").is_dir() else Path(__file__).resolve().parent.parent / "data"
_BUDGET_PATH = _BUDGET_DIR / "flight_quota.json"

# AirLabs' free tier is ~1000 requests/month, so a flat daily allowance leaves headroom rather
# than letting a busy afternoon spend the month.
DEFAULT_DAILY_BUDGETS: dict[str, int] = {"airlabs": 30, "flightstats": 250}


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


class Budget:
    """A per-UTC-day call allowance, persisted so restarts cannot reset it."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._day: str = _today()
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            saved = json.loads(_BUDGET_PATH.read_text())
        except (OSError, ValueError):
            return
        if isinstance(saved, dict) and saved.get("day") == self._day:
            counts = saved.get("counts")
            if isinstance(counts, dict):
                self._counts = {str(k): int(v) for k, v in counts.items() if isinstance(v, int)}

    def _save(self) -> None:
        try:
            _BUDGET_DIR.mkdir(parents=True, exist_ok=True)
            _BUDGET_PATH.write_text(json.dumps({"day": self._day, "counts": self._counts}))
        except OSError:
            # A read-only or missing volume must not take the flight board down with it; the
            # budget simply falls back to being per-process.
            pass

    def _roll(self) -> None:
        today = _today()
        if today != self._day:
            self._day = today
            self._counts = {}
            self._save()

    def limit(self, source: str) -> int:
        env = os.getenv(f"{source.upper()}_DAILY_BUDGET")
        if env:
            try:
                return max(0, int(env))
            except ValueError:
                pass
        return DEFAULT_DAILY_BUDGETS.get(source, 0)

    def used(self, source: str) -> int:
        self._load()
        self._roll()
        return self._counts.get(source, 0)

    def remaining(self, source: str) -> int:
        return max(0, self.limit(source) - self.used(source))

    def allows(self, source: str) -> bool:
        return self.remaining(source) > 0

    def spend(self, source: str) -> None:
        self._load()
        self._roll()
        self._counts[source] = self._counts.get(source, 0) + 1
        self._save()

    def snapshot(self) -> dict[str, dict[str, int]]:
        self._load()
        self._roll()
        return {
            source: {"used": self.used(source), "limit": self.limit(source), "remaining": self.remaining(source)}
            for source in DEFAULT_DAILY_BUDGETS
        }


budget = Budget()


# ---------------------------------------------------------------------------
# FlightStats (last-resort schedule fallback)
# ---------------------------------------------------------------------------

FLIGHTSTATS_URL = "https://www.flightstats.com/v2/flight-tracker/{carrier}/{number}"

# The page ships its state as a JSON blob for client-side hydration; this reads that blob rather
# than parsing rendered markup, which is far more brittle. It is undocumented and unversioned, so
# this source is deliberately last -- see `schedule_from_flightstats`.
_NEXT_DATA_MARKER = "__NEXT_DATA__ = "

_FLIGHT_QUERY_RE = re.compile(r"^([A-Z]{2,3})\s*(\d{1,4})$")


def split_flight_number(iata_number: str | None) -> tuple[str, str] | None:
    """"AA193" -> ("AA", "193"). None when it isn't a carrier+number pair."""
    if not iata_number:
        return None
    match = _FLIGHT_QUERY_RE.match(iata_number.strip().upper())
    if not match:
        return None
    return match.group(1), match.group(2)


def _extract_next_data(html: str) -> dict[str, Any] | None:
    start = html.find(_NEXT_DATA_MARKER)
    if start == -1:
        return None
    try:
        # The blob is followed by more script, so decode just the one JSON value.
        payload, _ = json.JSONDecoder().raw_decode(html[start + len(_NEXT_DATA_MARKER):])
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _time_of(times: dict[str, Any] | None, key: str) -> str | None:
    entry = (times or {}).get(key) or {}
    time24 = entry.get("time24")
    zone = entry.get("timezone")
    if not time24:
        return None
    return f"{time24} {zone}" if zone else str(time24)


def parse_flightstats(payload: dict[str, Any]) -> dict[str, Any]:
    """Pull the schedule fields this dashboard shows out of the page's hydration state."""
    # Walked with an `or {}` at every level rather than a default argument: this is an undocumented
    # blob from a page that can change shape without notice, and a `null` anywhere along the path
    # satisfies `.get(key, {})` while still being unsubscriptable.
    flight: Any = payload
    for step in ("props", "initialState", "flightTracker", "flight"):
        flight = (flight or {}).get(step) if isinstance(flight, dict) else None
    if not isinstance(flight, dict):
        return {}

    schedule = flight.get("schedule") or {}
    status = flight.get("status") or {}
    departure = flight.get("departureAirport") or {}
    arrival = flight.get("arrivalAirport") or {}
    delay = status.get("delayStatus") or {}

    result: dict[str, Any] = {
        "depScheduled": schedule.get("scheduledDepartureUTC"),
        "depActual": schedule.get("estimatedActualDepartureUTC") if schedule.get("estimatedActualDepartureTitle") == "Actual" else None,
        "arrScheduled": schedule.get("scheduledArrivalUTC"),
        "arrEstimated": schedule.get("estimatedActualArrivalUTC"),
        "delayMin": delay.get("minutes"),
        "status": (status.get("status") or "").lower() or None,
        # Only this source has these, and they are the details a person meeting a flight
        # actually wants, so they are surfaced rather than flattened away.
        "depGate": departure.get("gate"),
        "depTerminal": departure.get("terminal"),
        "arrGate": arrival.get("gate"),
        "arrTerminal": arrival.get("terminal"),
        "baggage": arrival.get("baggage"),
        "depTimeLocal": _time_of(departure.get("times"), "scheduled"),
        "arrTimeLocal": _time_of(arrival.get("times"), "scheduled"),
        "fromCode": departure.get("iata") or departure.get("fs"),
        "fromCity": departure.get("city"),
        "toCode": arrival.get("iata") or arrival.get("fs"),
        "toCity": arrival.get("city"),
        "source": "flightstats",
    }

    track = (flight.get("positional") or {}).get("flexTrack") or {}
    if track.get("callsign"):
        result["_callsign"] = str(track["callsign"]).strip().upper()
    if track.get("tailNumber"):
        result["reg"] = str(track["tailNumber"]).strip().upper()

    return {key: value for key, value in result.items() if value is not None}


async def schedule_from_flightstats(
    client: httpx.AsyncClient, iata_number: str | None, on_error: Any
) -> dict[str, Any]:
    """Schedule for one flight, scraped as the last resort when no keyed feed can answer.

    This reads an undocumented internal JSON blob out of a public page, so it can break without
    notice and is called only when AirLabs is unset or out of budget. Its own budget and the
    per-host spacing keep it to a trickle.
    """
    parts = split_flight_number(iata_number)
    if not parts:
        return {}
    carrier, number = parts

    url = FLIGHTSTATS_URL.format(carrier=carrier, number=number)
    await throttle(url)
    try:
        response = await client.get(
            url,
            timeout=15,
            follow_redirects=True,
            headers={
                # The page returns a JS-only shell to unrecognised clients, which contains no
                # hydration blob to read.
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        on_error("flightstats", str(error))
        return {}

    payload = _extract_next_data(response.text)
    if payload is None:
        on_error("flightstats", "page carried no readable flight data")
        return {}
    return parse_flightstats(payload)
