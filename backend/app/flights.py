"""Flight-tracking data layer, ported from FlyInk-Board's aircraft-tracking logic.

Only the DATA layer is ported here (OpenSky + adsbdb + AirLabs lookups, geometry,
classification, route-progress math). There is no e-ink rendering, no Raspberry
Pi, and no background polling loop -- every GET resolves state fresh, using
short-lived in-memory caches to stay within the free upstream APIs' rate limits.

All upstream calls degrade gracefully: missing API keys, timeouts, and non-200
responses never raise -- callers get `None`/`{}`/empty-list fallbacks instead,
matching this codebase's `HomeAssistantClient.health()` pattern.
"""

from __future__ import annotations

import asyncio
import itertools
import math
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from . import flight_sources

router = APIRouter(prefix="/api/flights")

# A module-wide client reuses TCP/TLS connections across requests instead of paying a fresh
# handshake to OpenSky/adsbdb/AirLabs on every poll -- these endpoints are hit constantly while
# the Flights section is on screen. Mirrors HomeAssistantClient's single shared client.
_http_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


class _SharedClient:
    """`async with _SharedClient() as client:` hands out the shared client without closing it on
    exit, so existing call sites keep their `async with` shape and indentation."""

    async def __aenter__(self) -> httpx.AsyncClient:
        return get_http_client()

    async def __aexit__(self, *exc_info: object) -> None:
        return None

# ---------------------------------------------------------------------------
# Upstream endpoints
# ---------------------------------------------------------------------------

OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all"
OPENSKY_FLIGHTS_URL = "https://opensky-network.org/api/flights/aircraft"
OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
)
ADSBDB_BASE_URL = "https://api.adsbdb.com/v0"
AIRLABS_FLIGHT_URL = "https://airlabs.co/api/v9/flight"

# Route-corridor sanity check + live climb/descent-based airport inference, mirroring the
# source project's thresholds exactly (see module docstring). These are what stop a stale or
# wrong *scheduled* callsign route (candidate below) from being shown as fact.
DEP_ALT_M = 7600        # climbing ceiling for departure detection (~25,000 ft)
DEP_RADIUS_KM = 90
ARR_ALT_M = 4500        # descending ceiling for arrival detection (~15,000 ft)
ARR_RADIUS_KM = 70
NEAR_ENDPOINT_KM = 60   # within this of an endpoint counts as "on corridor"
ROUTE_SLACK = 1.5       # corridor width multiplier
ROUTE_PAD_KM = 120      # flat additional corridor padding
MAX_HEADING_MISMATCH_DEG = 100.0  # beyond this, the plane isn't heading toward *either* endpoint
FLIGHT_HISTORY_CACHE_TTL = 1800.0
FLIGHT_HISTORY_ERROR_TTL = 300.0  # retry sooner after a throttled/failed lookup than after a real answer

# OpenSky stores /flights/aircraft by UTC day and rejects any range that touches a third day
# ("You can only query across 2 partitions (days)", HTTP 400). A 24h window touches at most two,
# so it is the longest lookback that is always accepted.
FLIGHT_HISTORY_WINDOW_S = 86_400

# Expanding bbox search radii (km): starts tight so the radar/map stay at a legible
# local scale, and only widens if nothing is found nearby.
SEARCH_RADII: list[float] = [75, 150, 300, 700]

# Cache TTLs (seconds), mirroring the source project's cache lifetimes.
STATES_CACHE_TTL = 60.0
# How long a tracked aircraft's last known state vector stands in for a rate-limited fetch.
STATE_ROW_TTL = 180.0
# A feed failure this recent is treated as the reason a pinned flight has no position.
UPSTREAM_STALE_S = 120.0
ROUTE_CACHE_TTL = 3600.0
AIRCRAFT_CACHE_TTL = 86400.0
# How long a landed flight stays on the board before it is retired. Long enough that a flight which
# landed while nobody was watching is still there to be seen, and that someone meeting an arrival can
# check the gate and baggage claim after it is down -- half an hour retired them before anyone looked.
TRACK_LINGER_S = 21600.0
# A pin that never once produced a live position is dropped after this, so a typo cannot sit on the
# board forever. The clock only runs while the flight has never been seen.
TRACK_UNSEEN_S = 21600.0
# A cached hex that stops returning a state vector is re-resolved after this. Callsigns are reused
# day to day, so a hex resolved from a stale scan can otherwise strand the pin in "await" for good.
TRACK_RERESOLVE_S = 420.0
# Each pinned flight costs its own upstream calls per poll, so the board is deliberately small.
MAX_TRACKED_FLIGHTS = 6

# ---------------------------------------------------------------------------
# Static reference data
# ---------------------------------------------------------------------------

AIRLINES: dict[str, str] = {
    "AAL": "American Airlines",
    "UAL": "United Airlines",
    "DAL": "Delta Air Lines",
    "SWA": "Southwest Airlines",
    "JBU": "JetBlue",
    "ASA": "Alaska Airlines",
    "FFT": "Frontier",
    "NKS": "Spirit Airlines",
    "SKW": "SkyWest",
    "ENY": "Envoy Air",
    "RPA": "Republic Airways",
    "EDV": "Endeavor Air",
    "AAY": "Allegiant Air",
    "FDX": "FedEx",
    "UPS": "UPS Airlines",
    "EJA": "NetJets",
    "LXJ": "Flexjet",
}

IATA_TO_ICAO: dict[str, str] = {
    "AA": "AAL", "UA": "UAL", "DL": "DAL", "WN": "SWA", "B6": "JBU", "AS": "ASA",
    "F9": "FFT", "NK": "NKS", "G4": "AAY", "HA": "HAL", "AC": "ACA", "WS": "WJA",
    "BA": "BAW", "LH": "DLH", "AF": "AFR", "KL": "KLM", "EK": "UAE", "QR": "QTR",
    "SQ": "SIA", "NH": "ANA", "JL": "JAL", "FR": "RYR", "U2": "EZY", "VS": "VIR",
    "FI": "ICE", "AM": "AMX", "Y4": "VOI", "CX": "CPA", "KE": "KAL", "QF": "QFA",
    "EY": "ETD", "TK": "THY", "IB": "IBE",
}
ICAO_TO_IATA: dict[str, str] = {icao: iata for iata, icao in IATA_TO_ICAO.items()}
KNOWN_ICAO_PREFIXES = set(IATA_TO_ICAO.values())

# Nearby airports for live climb/descent-based departure/arrival inference: ICAO -> (IATA,
# display name, lat, lon). Region-specific by design (same approach the source project uses) --
# extend this for your own location; entries far from `home_lat`/`home_lon` just never match.
AIRPORTS: dict[str, tuple[str, str, float, float]] = {
    "KAUS": ("AUS", "Austin-Bergstrom Intl", 30.1945, -97.6699),
    "KGTU": ("GTU", "Georgetown Municipal", 30.6786, -97.6794),
    "KEDC": ("EDC", "Austin Executive", 30.3917, -97.5664),
    "KGRK": ("GRK", "Killeen Regional", 31.0672, -97.8289),
    "KSAT": ("SAT", "San Antonio Intl", 29.5337, -98.4698),
    "KSSF": ("SSF", "Stinson Municipal", 29.3370, -98.4710),
    "KACT": ("ACT", "Waco Regional", 31.6113, -97.2305),
    "KCLL": ("CLL", "College Station", 30.5886, -96.3638),
    "KTPL": ("TPL", "Temple", 31.1525, -97.4078),
    "KBAZ": ("BAZ", "New Braunfels", 29.7045, -98.0421),
    "KDFW": ("DFW", "Dallas-Fort Worth Intl", 32.8968, -97.0380),
    "KDAL": ("DAL", "Dallas Love Field", 32.8471, -96.8518),
    "KAFW": ("AFW", "Fort Worth Alliance", 32.9876, -97.3188),
    "KHOU": ("HOU", "Houston Hobby", 29.6454, -95.2789),
    "KIAH": ("IAH", "Houston Bush Intl", 29.9902, -95.3368),
    "KBNA": ("BNA", "Nashville Intl", 36.1245, -86.6782),
    "KATL": ("ATL", "Atlanta Intl", 33.6407, -84.4277),
    "KORD": ("ORD", "Chicago O'Hare", 41.9742, -87.9073),
    "KMDW": ("MDW", "Chicago Midway", 41.7868, -87.7522),
    "KDEN": ("DEN", "Denver Intl", 39.8561, -104.6737),
    "KLAX": ("LAX", "Los Angeles Intl", 33.9416, -118.4085),
    "KPHX": ("PHX", "Phoenix Sky Harbor", 33.4342, -112.0116),
    "KLAS": ("LAS", "Las Vegas Reid", 36.0840, -115.1537),
    "KMCO": ("MCO", "Orlando Intl", 28.4312, -81.3081),
    "KMIA": ("MIA", "Miami Intl", 25.7959, -80.2870),
    "KJFK": ("JFK", "New York JFK", 40.6413, -73.7781),
    "KEWR": ("EWR", "Newark Liberty", 40.6895, -74.1745),
    "KSEA": ("SEA", "Seattle-Tacoma", 47.4502, -122.3088),
    "KSFO": ("SFO", "San Francisco Intl", 37.6213, -122.3790),
    "KMSP": ("MSP", "Minneapolis-St Paul", 44.8848, -93.2223),
}

# Small/GA fields, de-prioritised in live-motion matching once a commercial callsign is known.
SMALL_FIELDS: set[str] = {"GTU", "EDC", "GRK", "SSF", "ACT", "CLL", "TPL", "BAZ", "AFW"}

# Aircraft classifier: string-contains on `type`, case-insensitive, first group wins.
CLASSIFIER_GROUPS: list[tuple[str, list[str]]] = [
    ("heli", [
        "helicopter", "robinson", "sikorsky", "eurocopter", "bell ", "ec135", "ec145",
        "ec130", "as350", "h125", "h130", "h145", "r44", "r66", "md 500", "aw139", "aw169",
    ]),
    ("heavy", [
        "747", "777", "787", "a380", "a350", "a330", "a340", "767", "md-11", "dc-10",
        "a300", "a310", "il-96",
    ]),
    ("bizjet", [
        "citation", "gulfstream", "learjet", "challenger", "global", "falcon", "phenom",
        "hawker", "legacy", "praetor", "vision jet", "hondajet", "g550", "g650",
    ]),
    ("turboprop", [
        "king air", "caravan", "cessna 208", "atr ", "atr-", "dash 8", "dhc-8", "q400",
        "pc-12", "pc-xii", "tbm", "pilatus", "saab 340", "beech 1900", "metroliner", "do228",
        "twin otter", "dhc-6",
    ]),
    ("light", [
        "cessna 1", "cessna 2", "piper", "cirrus", "sr20", "sr22", "diamond", "da40",
        "da42", "pa-", "c172", "c152", "c182", "bonanza", "mooney", "grumman", "tecnam",
    ]),
]

COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

# ---------------------------------------------------------------------------
# In-memory caches (module-level; no disk persistence, single async process)
# ---------------------------------------------------------------------------

_opensky_token: dict[str, Any] = {"value": None, "expires_at": 0.0}
_opensky_token_lock = asyncio.Lock()

# Last failure seen per upstream, so /api/flights/status can explain an empty board instead of
# leaving the silent degrade-to-None paths below looking like "no aircraft nearby".
_last_upstream_error: dict[str, dict[str, Any]] = {}


def _note_upstream(source: str, detail: str) -> None:
    _last_upstream_error[source] = {"detail": detail, "at": time.time()}


# Which feed last answered a position query, so /status can say the board is alive on a fallback
# rather than reporting OpenSky as broken and leaving the screen looking unexplained.
_active_position_source: dict[str, Any] = {"name": "opensky", "at": 0.0}


def _note_source(name: str) -> None:
    _active_position_source["name"] = name
    _active_position_source["at"] = time.time()


def _prime_aircraft_cache(records: list[dict[str, Any]]) -> None:
    """Seed the adsbdb aircraft cache from registration/type a community feed already returned.

    Only fills empty slots: a real adsbdb answer carries more (owner, manufacturer) and must not
    be overwritten by the thinner feed version.
    """
    now = time.time()
    for record in records:
        icao24 = (record.get("hex") or "").strip().lower().lstrip("~")
        if not icao24:
            continue
        info = flight_sources.aircraft_info_from_feed(record)
        if not info:
            continue
        cache_key = (icao24, None)
        cached = _aircraft_cache.get(cache_key)
        if cached and cached[1]:
            continue
        _aircraft_cache[cache_key] = (now, info, cached[2] if cached else None)


def upstream_failing(source: str, now: float | None = None) -> bool:
    """Has this feed failed recently enough to be the explanation for a missing position?"""
    entry = _last_upstream_error.get(source)
    return bool(entry) and ((now or time.time()) - entry["at"]) < UPSTREAM_STALE_S


# key: icao24 (lower) -> (fetched_at, state vector). Carries a tracked flight across the gaps in a
# rate-limited feed; see fetch_state_by_icao24.
_state_row_cache: dict[str, tuple[float, list[Any]]] = {}

# Single-slot list holding (fetched_at, states) for the whole-planet snapshot; see _all_states.
_all_states_cache: list[tuple[float, list[Any]]] = []

# key: (round(lat, 2), round(lon, 2), radius_km) -> (fetched_at, states)
_states_cache: dict[tuple[float, float, float], tuple[float, list[Any]]] = {}

# key: callsign (upper) -> (fetched_at, adsbdb flightroute dict | None)
_route_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

# key: (icao24 lower, callsign upper | None) -> (fetched_at, adsbdb aircraft dict | None, adsbdb flightroute dict | None)
_aircraft_cache: dict[tuple[str, str | None], tuple[float, dict[str, Any] | None, dict[str, Any] | None]] = {}

# Pinned-flight tracking state, guarded by asyncio.Lock (single async process). Keyed by the
# normalised callsign and insertion-ordered, so the dashboard rotates flights in the order pinned.
_track: dict[str, dict[str, Any]] = {}
_track_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points, in km."""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, in degrees 0-360."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def compass_label(bearing_deg: float) -> str:
    """8-point compass label (N/NE/E/SE/S/SW/W/NW) for a bearing in degrees."""
    idx = round(bearing_deg / 45.0) % 8
    return COMPASS_POINTS[idx]


def angle_off(track_deg: float, bearing_deg: float) -> float:
    """Smallest angle (0-180) between a heading and a bearing."""
    return abs(((bearing_deg - track_deg + 180) % 360) - 180)


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _airport_obj(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalizes an adsbdb origin/destination dict into {code, city, country, lat, lon}."""
    if not raw:
        return None
    return {
        "code": raw.get("iata_code") or raw.get("icao_code"),
        "city": raw.get("municipality") or raw.get("name"),
        "country": raw.get("country_name") or raw.get("country_iso_name"),
        "lat": _to_float(raw.get("latitude")),
        "lon": _to_float(raw.get("longitude")),
    }


def resolve_airport(icao: str | None) -> dict[str, Any] | None:
    """ICAO code -> {code, city, lat, lon}, using the local AIRPORTS table when known."""
    if not icao:
        return None
    icao = icao.upper()
    if icao in AIRPORTS:
        iata, name, lat, lon = AIRPORTS[icao]
        return {"code": iata, "city": name, "lat": lat, "lon": lon}
    code = icao[1:] if (len(icao) == 4 and icao[0] == "K") else icao
    return {"code": code, "city": None, "lat": None, "lon": None}


IATA_TO_AIRPORT: dict[str, tuple[str, float, float]] = {
    iata: (name, lat, lon) for iata, name, lat, lon in AIRPORTS.values()
}


def _schedule_airport(code: str | None, city: str | None) -> dict[str, Any] | None:
    """A schedule feed's IATA code as a route endpoint, with coordinates when the code is known.

    The schedule sources give codes and city names but no coordinates, and coordinates are what
    the route map and progress maths need. `AIRPORTS` supplies them for the fields it covers;
    elsewhere the endpoint is still worth showing as a label.
    """
    if not code:
        return None
    code = code.strip().upper()
    known = IATA_TO_AIRPORT.get(code)
    if known:
        name, lat, lon = known
        return {"code": code, "city": city or name, "lat": lat, "lon": lon}
    return {"code": code, "city": city, "lat": None, "lon": None}


def _merge_airport(primary: dict[str, Any] | None, extra: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep the schedule's naming, borrow whatever fields it left empty (chiefly coordinates)."""
    if not primary:
        return extra
    if not extra:
        return primary
    # A code mismatch means the two sources disagree about the routing; trust the schedule, which
    # is specific to today, over the historical callsign mapping.
    if primary.get("code") and extra.get("code") and primary["code"] != extra["code"]:
        return primary
    return {**extra, **{key: value for key, value in primary.items() if value is not None}}


def route_payload(origin: dict[str, Any] | None, dest: dict[str, Any] | None) -> dict[str, Any] | None:
    """The route as the frontend consumes it: codes and cities to read, coordinates to draw.

    The coordinates are what lets the Track page plot a real route line instead of a bar; they are
    emitted per-side, because one endpoint is routinely known while the other is still unresolved.
    """
    if not (origin or dest):
        return None
    return {
        "fromCode": origin.get("code") if origin else None,
        "fromCity": origin.get("city") if origin else None,
        "fromLat": origin.get("lat") if origin else None,
        "fromLon": origin.get("lon") if origin else None,
        "toCode": dest.get("code") if dest else None,
        "toCity": dest.get("city") if dest else None,
        "toLat": dest.get("lat") if dest else None,
        "toLon": dest.get("lon") if dest else None,
    }


def on_corridor(plat: float | None, plon: float | None, origin: dict[str, Any] | None, dest: dict[str, Any] | None) -> bool:
    """True if the aircraft's current position is plausibly on the route between origin and dest.

    This is the sanity check a scheduled callsign route needs: airlines reuse flight numbers
    across different city pairs on different days, so adsbdb's schedule lookup for a callsign
    is a *guess*, not necessarily today's actual routing. Reject it outright if the plane isn't
    anywhere near that corridor.
    """
    if not (origin and dest and origin.get("lat") is not None and dest.get("lat") is not None):
        return True
    if plat is None or plon is None:
        return True
    d_od = haversine(origin["lat"], origin["lon"], dest["lat"], dest["lon"])
    d_o = haversine(plat, plon, origin["lat"], origin["lon"])
    d_d = haversine(plat, plon, dest["lat"], dest["lon"])
    if min(d_o, d_d) <= NEAR_ENDPOINT_KM:
        return True
    corridor_limit = d_od * (ROUTE_SLACK * 1.35) + (ROUTE_PAD_KM * 1.5)
    return (d_o + d_d) <= corridor_limit


def _field_match(
    plat: float, plon: float, track: float | None, want_toward: bool, max_km: float, has_airline: bool
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_score: float | None = None
    for iata, name, alat, alon in AIRPORTS.values():
        dd = haversine(plat, plon, alat, alon)
        if dd > max_km:
            continue
        if track is not None:
            brg = bearing(plat, plon, alat, alon) if want_toward else bearing(alat, alon, plat, plon)
            if angle_off(track, brg) > 75:
                continue
        score = dd + (120 if (has_airline and iata in SMALL_FIELDS) else 0)
        if best_score is None or score < best_score:
            best = {"code": iata, "city": name, "lat": alat, "lon": alon}
            best_score = score
    return best


def departure_airport(
    plat: float | None, plon: float | None, track: float | None, vrate: float | None, alt_m: float | None, has_airline: bool
) -> dict[str, Any] | None:
    """Live climb-based inference: is this aircraft plausibly climbing out of a nearby airport right now?"""
    if plat is None or plon is None or vrate is None or vrate < 1.0 or alt_m is None or alt_m > DEP_ALT_M:
        return None
    return _field_match(plat, plon, track, False, DEP_RADIUS_KM, has_airline)


def arrival_airport(
    plat: float | None, plon: float | None, track: float | None, vrate: float | None, alt_m: float | None, has_airline: bool
) -> dict[str, Any] | None:
    """Live descent-based inference: is this aircraft plausibly descending into a nearby airport right now?"""
    if plat is None or plon is None or vrate is None or vrate > -1.0 or alt_m is None or alt_m > ARR_ALT_M:
        return None
    return _field_match(plat, plon, track, True, ARR_RADIUS_KM, has_airline)


def bbox_for(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Bounding box (lamin, lomin, lamax, lomax) around a center point."""
    dlat = radius_km / 111.0
    cos_lat = math.cos(math.radians(lat))
    dlon = radius_km / (111.0 * cos_lat) if abs(cos_lat) > 1e-6 else radius_km / 111.0
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def _meters_per_sec_to_knots(value: float | None) -> float | None:
    return round(value * 1.94384) if value is not None else None


def _meters_to_feet(value: float | None) -> float | None:
    return round(value * 3.28084) if value is not None else None


def _meters_per_sec_to_fpm(value: float | None) -> float | None:
    return round(value * 196.850394) if value is not None else None


# ---------------------------------------------------------------------------
# Aircraft classification / airline lookup
# ---------------------------------------------------------------------------

def classify_aircraft(type_str: str | None, has_airline: bool) -> str:
    # Upstream type strings punctuate inconsistently: a real sample had an AW169 helicopter arrive
    # as "AW.169" and a Pilatus PC-12 as "PC-XII NGX", both of which slipped past every needle here
    # and fell through to the "jet" default -- a helicopter drawn as an airliner. Matching against
    # both the raw text and a punctuation-stripped copy catches the separator variants.
    text = (type_str or "").strip().lower()
    if not text:
        return "jet" if has_airline else "light"
    squashed = text.replace(".", "").replace("-", "").replace(" ", "")
    for kind, needles in CLASSIFIER_GROUPS:
        for needle in needles:
            if needle in text or needle.replace(".", "").replace("-", "").replace(" ", "") in squashed:
                return kind
    return "jet"


def derive_airline_code(callsign: str | None) -> str | None:
    """First 3 chars if alphabetic AND the 4th char is a digit."""
    if not callsign or len(callsign) < 4:
        return None
    prefix, digit = callsign[:3], callsign[3]
    if prefix.isalpha() and digit.isdigit():
        return prefix.upper()
    return None


def normalize_query(raw: str) -> tuple[str, str | None]:
    """Normalize a user-typed flight query into (icao_callsign, iata_number | None)."""
    q = raw.strip().upper().replace(" ", "")
    if not q:
        return q, None

    prefix2, prefix3 = q[:2], q[:3]
    looks_icao = len(q) > 3 and q[:3].isalpha() and q[3].isdigit()

    icao_callsign = q
    if looks_icao:
        if prefix2 in IATA_TO_ICAO and prefix3 not in KNOWN_ICAO_PREFIXES:
            icao_callsign = IATA_TO_ICAO[prefix2] + q[2:]
    elif prefix2 in IATA_TO_ICAO:
        icao_callsign = IATA_TO_ICAO[prefix2] + q[2:]

    iata_number: str | None = None
    icao_prefix = icao_callsign[:3]
    if icao_prefix in ICAO_TO_IATA:
        iata_number = ICAO_TO_IATA[icao_prefix] + icao_callsign[3:]
    elif prefix2 in IATA_TO_ICAO:
        iata_number = q

    return icao_callsign, iata_number


# ---------------------------------------------------------------------------
# OpenSky
# ---------------------------------------------------------------------------

async def get_opensky_token(client: httpx.AsyncClient) -> str | None:
    """OAuth2 client-credentials token, cached in memory until near expiry.

    Anonymous OpenSky access works without this -- it's purely an optional
    rate-limit upgrade when OPENSKY_CLIENT_ID/SECRET are configured.
    """
    client_id = os.getenv("OPENSKY_CLIENT_ID")
    client_secret = os.getenv("OPENSKY_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None

    now = time.time()
    async with _opensky_token_lock:
        if _opensky_token["value"] and _opensky_token["expires_at"] - now > 30:
            return _opensky_token["value"]
        try:
            response = await client.post(
                OPENSKY_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                timeout=10,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            _note_upstream("opensky_token", str(error))
            return None

        token = payload.get("access_token")
        expires_in = payload.get("expires_in", 1800)
        if not token:
            return None
        _opensky_token["value"] = token
        try:
            _opensky_token["expires_at"] = now + float(expires_in)
        except (TypeError, ValueError):
            _opensky_token["expires_at"] = now + 1800.0
        return token


async def _opensky_headers(client: httpx.AsyncClient) -> dict[str, str]:
    token = await get_opensky_token(client)
    return {"Authorization": f"Bearer {token}"} if token else {}


async def fetch_states_in_radius(
    client: httpx.AsyncClient, lat: float, lon: float, radius_km: float
) -> list[list[Any]]:
    """Bbox states query around (lat, lon), cached ~60s per rounded lat/lon+radius.

    Falls back to the keyless community feeds when OpenSky returns nothing. Anonymous OpenSky
    rate-limits constantly, and treating that as "no aircraft nearby" is what left the radar
    blank; the feeds need no key and cover the same airspace.
    """
    key = (round(lat, 2), round(lon, 2), radius_km)
    now = time.time()
    cached = _states_cache.get(key)
    if cached and now - cached[0] < STATES_CACHE_TTL:
        return cached[1]

    lamin, lomin, lamax, lomax = bbox_for(lat, lon, radius_km)
    params = {"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax}
    headers = await _opensky_headers(client)

    states: list[list[Any]] = []
    try:
        response = await client.get(OPENSKY_STATES_URL, params=params, headers=headers, timeout=15)
        response.raise_for_status()
        payload = response.json()
        states = payload.get("states") or []
    except (httpx.HTTPError, ValueError) as error:
        _note_upstream("opensky_states", str(error))
        states = []

    if not states:
        states, records, feed = await flight_sources.feed_states_in_radius(
            client, lat, lon, radius_km, _note_upstream
        )
        if feed:
            _note_source(feed)
            # The feeds return registration and type alongside the position, so priming the
            # aircraft cache here spares one adsbdb request per aircraft on screen.
            _prime_aircraft_cache(records)

    _states_cache[key] = (now, states)
    return states


async def fetch_state_by_icao24(client: httpx.AsyncClient, icao24: str) -> list[Any] | None:
    """The aircraft's current state vector, or the last one seen if the feed is unreachable.

    Anonymous OpenSky answers `429 Too many requests` freely, and a pinned board polling every ten
    seconds runs into it constantly. Treating that failure as "no position" is what made a flight
    that is demonstrably airborne flip to "Awaiting" between polls, so a rate-limited fetch falls
    back to the last known row for a few minutes instead. A *successful* fetch that returns nothing
    is different -- the aircraft really has stopped reporting -- and clears the cache.
    """
    key = icao24.lower()
    headers = await _opensky_headers(client)
    reachable = True
    states: list[Any] = []
    try:
        response = await client.get(
            OPENSKY_STATES_URL, params={"icao24": key}, headers=headers, timeout=15
        )
        response.raise_for_status()
        payload = response.json()
        states = payload.get("states") or []
    except (httpx.HTTPError, ValueError) as error:
        _note_upstream("opensky_states", str(error))
        reachable = False

    if states:
        _state_row_cache[key] = (time.time(), states[0])
        return states[0]

    # Before concluding the aircraft has gone quiet, ask the keyless feeds -- they frequently have
    # a position when OpenSky's anonymous tier has either throttled us or simply lacks coverage.
    row, record, feed = await flight_sources.feed_lookup(client, "hex", key, _note_upstream)
    if row:
        _note_source(feed or "adsb")
        if record:
            _prime_aircraft_cache([record])
        _state_row_cache[key] = (time.time(), row)
        return row

    if reachable:
        _state_row_cache.pop(key, None)
        return None

    cached = _state_row_cache.get(key)
    return cached[1] if cached and (time.time() - cached[0]) < STATE_ROW_TTL else None


def flight_number_of(callsign: str | None) -> str | None:
    """The numeric part of a callsign: AAL9195 -> "9195". None when it has no trailing number.

    An airline's own designator is only half of a callsign; the number is the half that survives
    being handed to a partner. `operated_by` below matches on it.
    """
    text = (callsign or "").strip().upper()
    # Airline callsign shape only -- three letters then the number. Anything else is a registration
    # (N172SP, D-EABC), and reading "172" out of a Cessna's tail number as a flight number would
    # let a light aircraft stand in for an airliner.
    if len(text) < 4 or not text[:3].isalpha():
        return None
    digits = "".join(itertools.takewhile(str.isdigit, text[3:]))
    return digits or None


def operated_by(
    row: list[Any],
    icao_callsign: str,
    origin: dict[str, Any] | None,
    dest: dict[str, Any] | None,
) -> bool:
    """Is this state vector plausibly the pinned flight, flying under another airline's callsign?

    Regional affiliates keep the mainline flight number and swap the designator -- AA3456 flies as
    ENY3456 -- so an exact-callsign scan misses a large share of what people actually pin. Matching
    the number alone would be far too loose (every airline has a flight 3456), so a non-exact match
    additionally has to be airborne on the corridor between the pinned flight's own origin and
    destination, and pointed at that destination. Without a known route there is nothing to check
    against and the candidate is refused rather than guessed at.
    """
    number = flight_number_of(icao_callsign)
    candidate = (row[1] or "").strip().upper() if len(row) > 1 and row[1] else ""
    if not number or not candidate or candidate == icao_callsign:
        return False
    if flight_number_of(candidate) != number:
        return False
    if not (origin and dest):
        return False
    o_lat, o_lon, d_lat, d_lon = origin.get("lat"), origin.get("lon"), dest.get("lat"), dest.get("lon")
    if None in (o_lat, o_lon, d_lat, d_lon):
        return False

    lat, lon, track = row[6], row[5], row[10]
    if lat is None or lon is None or bool(row[8]):  # airborne positions only
        return False
    if not on_corridor(lat, lon, origin, dest):
        return False
    # Flying the corridor in the wrong direction is the return leg, not this flight.
    return track is not None and angle_off(track, bearing(lat, lon, d_lat, d_lon)) <= 75


async def _all_states(client: httpx.AsyncClient) -> list[Any]:
    """The whole state vector, cached and shared.

    Every unresolved pin used to scan the entire world on every ten-second poll -- six pins meant
    thirty-six full-planet queries a minute, which is how a board of ordinary flights talked itself
    into the rate limit that then made them all look untrackable. One snapshot now serves the whole
    board for a cache lifetime.
    """
    now = time.time()
    if _all_states_cache and (now - _all_states_cache[0][0]) < STATES_CACHE_TTL:
        return _all_states_cache[0][1]

    headers = await _opensky_headers(client)
    try:
        response = await client.get(OPENSKY_STATES_URL, headers=headers, timeout=20)
        response.raise_for_status()
        states = response.json().get("states") or []
    except (httpx.HTTPError, ValueError) as error:
        _note_upstream("opensky_states", str(error))
        return []

    _all_states_cache[:] = [(now, states)]
    return states


async def resolve_icao24_by_callsign(
    client: httpx.AsyncClient,
    callsign: str | None,
    origin: dict[str, Any] | None = None,
    dest: dict[str, Any] | None = None,
) -> str | None:
    """Find the aircraft flying a callsign, preferring a direct lookup over a whole-planet scan.

    The community feeds answer "which aircraft is flying SWA2275" in one small request. OpenSky
    has no such endpoint -- the only way is to download every state vector on earth and scan it --
    so the feeds are tried first here even when OpenSky is healthy.
    """
    if not callsign:
        return None

    row, record, feed = await flight_sources.feed_lookup(
        client, "callsign", callsign.strip().upper(), _note_upstream
    )
    if row and row[0]:
        _note_source(feed or "adsb")
        if record:
            _prime_aircraft_cache([record])
        _state_row_cache[str(row[0]).lower()] = (time.time(), row)
        return row[0]

    states = await _all_states(client)
    if not states:
        return None

    target = callsign.strip().upper()
    fallback: str | None = None
    for row in states:
        if not isinstance(row, list) or len(row) < 2:
            continue
        cs = (row[1] or "").strip().upper() if row[1] else ""
        if cs == target:
            return row[0]
        # The exact callsign always wins, so the whole list is scanned before settling for this.
        if fallback is None and len(row) > 10 and operated_by(row, target, origin, dest):
            fallback = row[0]
    if fallback:
        return fallback
    return None


_flight_history_cache: dict[str, tuple[float, tuple[str | None, str | None]]] = {}


async def flight_history(client: httpx.AsyncClient, icao24: str | None, callsign: str | None) -> tuple[str | None, str | None]:
    """Real (origin_icao, dest_icao) from this aircraft's actual recent OpenSky track history.

    Requires OPENSKY_CLIENT_ID/SECRET (anonymous access can't reach this endpoint usefully) --
    returns (None, None) when unavailable rather than erroring, same as every other optional
    upstream here.
    """
    if not icao24:
        return None, None
    hit = _flight_history_cache.get(icao24)
    if hit and time.time() - hit[0] < FLIGHT_HISTORY_CACHE_TTL:
        return hit[1]

    result: tuple[str | None, str | None] = (None, None)
    headers = await _opensky_headers(client)
    if not headers:
        _flight_history_cache[icao24] = (time.time(), result)
        return result

    now = int(time.time())
    # A throttled or errored lookup is not an answer, so it gets the short TTL below rather than
    # pinning this aircraft to "no route known" for the full half-hour.
    failed = False
    try:
        response = await client.get(
            OPENSKY_FLIGHTS_URL,
            params={"icao24": icao24.lower(), "begin": now - FLIGHT_HISTORY_WINDOW_S, "end": now},
            headers=headers,
            timeout=15,
        )
        if response.status_code == 200:
            flights = response.json()
            if isinstance(flights, list) and flights:
                flights.sort(key=lambda f: f.get("lastSeen", 0), reverse=True)
                top = flights[0]
                dep = top.get("estDepartureAirport")
                arr = top.get("estArrivalAirport")
                top_callsign = (top.get("callsign") or "").strip().upper()
                target = (callsign or "").strip().upper()
                result = (dep, arr) if top_callsign == target else (arr or dep, None)
        else:
            failed = True
            _note_upstream("opensky_history", f"HTTP {response.status_code}: {response.text[:120]}")
    except (httpx.HTTPError, ValueError) as error:
        failed = True
        _note_upstream("opensky_history", str(error))

    expires_at = now - FLIGHT_HISTORY_CACHE_TTL + FLIGHT_HISTORY_ERROR_TTL if failed else now
    _flight_history_cache[icao24] = (expires_at, result)
    return result


# ---------------------------------------------------------------------------
# adsbdb
# ---------------------------------------------------------------------------

async def adsbdb_route_lookup(client: httpx.AsyncClient, callsign: str) -> dict[str, Any] | None:
    key = callsign.strip().upper()
    now = time.time()
    cached = _route_cache.get(key)
    if cached and now - cached[0] < ROUTE_CACHE_TTL:
        return cached[1]

    result: dict[str, Any] | None = None
    try:
        response = await client.get(f"{ADSBDB_BASE_URL}/callsign/{key}", timeout=10)
        if response.status_code == 200:
            payload = response.json()
            result = (payload.get("response") or {}).get("flightroute")
    except (httpx.HTTPError, ValueError):
        result = None

    _route_cache[key] = (now, result)
    return result


async def adsbdb_aircraft_lookup(
    client: httpx.AsyncClient,
    icao24: str,
    callsign: str | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    key = icao24.strip().lower()
    callsign_key = callsign.strip().upper() if isinstance(callsign, str) and callsign.strip() else None
    now = time.time()
    cache_key = (key, callsign_key)
    cached = _aircraft_cache.get(cache_key)
    if cached and now - cached[0] < AIRCRAFT_CACHE_TTL:
        return cached[1], cached[2]

    aircraft_result: dict[str, Any] | None = None
    route_result: dict[str, Any] | None = None
    try:
        params = {"callsign": callsign_key} if callsign_key else None
        response = await client.get(f"{ADSBDB_BASE_URL}/aircraft/{key}", params=params, timeout=10)
        if response.status_code == 200:
            payload = response.json()
            data = payload.get("response") or {}
            aircraft_result = data.get("aircraft")
            route_result = data.get("flightroute")
    except (httpx.HTTPError, ValueError):
        aircraft_result = route_result = None

    _aircraft_cache[cache_key] = (now, aircraft_result, route_result)
    return aircraft_result, route_result


async def resolve_route(
    client: httpx.AsyncClient,
    route: dict[str, Any] | None,
    callsign: str | None,
    icao24: str | None,
    lat: float | None,
    lon: float | None,
    track: float | None,
    vertical_rate: float | None,
    altitude_m: float | None,
    has_airline: bool,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve (origin, dest) using the same priority the source project uses:
    live motion inference > real OpenSky flight history > corridor-checked adsbdb schedule.

    `route` is the already-fetched adsbdb callsign lookup (or None) -- callers already fetch it
    for airline name/code, so it's passed in rather than re-fetched here.
    """
    db_origin = db_dest = None
    if route:
        origin_raw = _airport_obj(route.get("origin"))
        dest_raw = _airport_obj(route.get("destination"))
        if origin_raw and dest_raw and on_corridor(lat, lon, origin_raw, dest_raw):
            if track is not None and lat is not None and lon is not None and origin_raw.get("lat") is not None and dest_raw.get("lat") is not None:
                # Orient by heading: destination is whichever endpoint we're actually flying toward.
                angle_to_origin = angle_off(track, bearing(lat, lon, origin_raw["lat"], origin_raw["lon"]))
                angle_to_dest = angle_off(track, bearing(lat, lon, dest_raw["lat"], dest_raw["lon"]))
                # adsbdb's callsign lookup has no date/freshness field -- it's a generic historical
                # mapping for that flight number, which airlines reuse across different city pairs.
                # A loose distance-based corridor check alone lets a wrong-but-nearby-hub route
                # through (e.g. a flight that just left a hub reads as "near" it regardless of
                # which of that hub's dozens of destinations is correct today). If the plane isn't
                # actually heading toward *either* claimed endpoint, distrust the pairing entirely
                # rather than force a best-guess label on it.
                if min(angle_to_origin, angle_to_dest) > MAX_HEADING_MISMATCH_DEG:
                    db_origin = db_dest = None
                else:
                    db_origin, db_dest = (dest_raw, origin_raw) if angle_to_origin < angle_to_dest else (origin_raw, dest_raw)
            else:
                db_origin, db_dest = origin_raw, dest_raw

    live_dep = departure_airport(lat, lon, track, vertical_rate, altitude_m, has_airline)
    live_arr = arrival_airport(lat, lon, track, vertical_rate, altitude_m, has_airline)

    hist_dep_icao, hist_arr_icao = await flight_history(client, icao24, callsign)
    hist_origin = resolve_airport(hist_dep_icao)
    hist_dest = resolve_airport(hist_arr_icao)

    origin = live_dep or hist_origin or db_origin
    dest = live_arr or hist_dest or db_dest

    # Never show the same airport as both ends.
    if origin and dest and origin.get("code") == dest.get("code"):
        dest = db_dest if (db_dest and db_dest.get("code") != origin.get("code")) else None

    return origin, dest


# ---------------------------------------------------------------------------
# AirLabs (optional)
# ---------------------------------------------------------------------------

async def airlabs_schedule(client: httpx.AsyncClient, iata_number: str | None) -> dict[str, Any]:
    """Schedule/delay for one pinned flight. Returns {} whenever unset or empty.

    Guarded by the daily budget: this used to be the one uncached upstream here, called once per
    pinned flight on every poll, which is how a metered key got spent.
    """
    api_key = os.getenv("AIRLABS_KEY")
    if not api_key or not iata_number:
        return {}
    if not flight_sources.budget.allows("airlabs"):
        _note_upstream("airlabs", "daily budget reached -- using free sources until UTC midnight")
        return {}

    flight_sources.budget.spend("airlabs")
    try:
        response = await client.get(
            AIRLABS_FLIGHT_URL,
            params={"api_key": api_key, "flight_iata": iata_number},
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        _note_upstream("airlabs", str(error))
        return {}

    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        _note_upstream("airlabs", str(payload["error"].get("message") or payload["error"]))
        return {}

    data = payload.get("response")
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        return {}

    result: dict[str, Any] = {
        "depScheduled": data.get("dep_time"),
        "depActual": data.get("dep_actual"),
        "arrScheduled": data.get("arr_time"),
        "arrEstimated": data.get("arr_estimated"),
        "delayMin": data.get("delayed"),
        "status": data.get("status"),
    }
    icao24 = data.get("hex")
    if icao24:
        result["_icao24"] = icao24
    result["source"] = "airlabs"
    return result


# key: iata number -> (fetched_at, schedule dict). A schedule changes on the order of minutes, not
# seconds, so a poll-rate cache here is what keeps the metered/scraped sources to a trickle.
_schedule_cache: dict[str, tuple[float, dict[str, Any]]] = {}
SCHEDULE_CACHE_TTL = 300.0
# An empty answer is retried sooner than a good one, but not on every poll.
SCHEDULE_EMPTY_TTL = 120.0


async def resolve_schedule(client: httpx.AsyncClient, iata_number: str | None) -> dict[str, Any]:
    """Schedule for a pinned flight from whichever source can answer, cached for both.

    FlightStats is the authoritative source here: it reports gate, terminal, baggage claim and a
    live status the keyed feed does not, and it needs no key. AirLabs runs second as the
    documented API, and fills any field the scrape left empty -- so losing either one degrades
    the detail on screen rather than emptying it.
    """
    if not iata_number:
        return {}

    key = iata_number.strip().upper()
    now = time.time()
    cached = _schedule_cache.get(key)
    if cached:
        ttl = SCHEDULE_CACHE_TTL if cached[1] else SCHEDULE_EMPTY_TTL
        if now - cached[0] < ttl:
            return dict(cached[1])

    result: dict[str, Any] = {}
    if flight_sources.budget.allows("flightstats"):
        flight_sources.budget.spend("flightstats")
        result = await flight_sources.schedule_from_flightstats(client, key, _note_upstream)

    airlabs = await airlabs_schedule(client, key)
    if airlabs:
        # Merged rather than replaced: whichever source answered first keeps its fields, and the
        # other one only supplies what is still missing.
        for field, value in airlabs.items():
            if value is not None and result.get(field) is None:
                result[field] = value
        if result.get("source") != "flightstats":
            result["source"] = "airlabs"

    _schedule_cache[key] = (now, dict(result))
    return result


# ---------------------------------------------------------------------------
# Aircraft entry builder (shared by /nearby and /track)
# ---------------------------------------------------------------------------

async def build_aircraft_entry(
    client: httpx.AsyncClient,
    row: list[Any],
    home_lat: float | None = None,
    home_lon: float | None = None,
) -> dict[str, Any]:
    icao24 = row[0]
    callsign_raw = row[1]
    callsign = callsign_raw.strip() if isinstance(callsign_raw, str) and callsign_raw.strip() else None
    lon, lat = row[5], row[6]
    baro_alt, on_ground, velocity = row[7], bool(row[8]), row[9]
    true_track, vertical_rate, geo_alt = row[10], row[11], row[13]

    distance_km: float | None = None
    bearing_deg: float | None = None
    if home_lat is not None and home_lon is not None and lat is not None and lon is not None:
        distance_km = round(haversine(home_lat, home_lon, lat, lon), 1)
        bearing_deg = round(bearing(home_lat, home_lon, lat, lon))

    airline_code = derive_airline_code(callsign)
    airline_name = AIRLINES.get(airline_code) if airline_code else None
    has_airline = bool(airline_code)  # basic guess, computed before the route lookup may refine it

    from_code = from_city = from_country = None
    to_code = to_city = to_country = None

    route = None
    aircraft_info = None
    if icao24:
        aircraft_info, route = await adsbdb_aircraft_lookup(client, icao24, callsign)
    if not route and callsign:
        route = await adsbdb_route_lookup(client, callsign)

    if route:
        route_airline = route.get("airline") or {}
        if route_airline.get("name"):
            airline_name = route_airline.get("name")
        if route_airline.get("icao"):
            airline_code = route_airline.get("icao")

    alt_for_motion = geo_alt if geo_alt is not None else baro_alt
    origin, dest = await resolve_route(
        client, route, callsign, icao24, lat, lon, true_track, vertical_rate, alt_for_motion, has_airline,
    )
    if origin:
        from_code, from_city, from_country = origin.get("code"), origin.get("city"), origin.get("country")
    if dest:
        to_code, to_city, to_country = dest.get("code"), dest.get("city"), dest.get("country")

    reg: str | None = None
    if aircraft_info:
        reg = aircraft_info.get("registration")
    aircraft_type: str | None = None
    if aircraft_info:
        aircraft_type = aircraft_info.get("type") or aircraft_info.get("icao_type")

    kind = classify_aircraft(aircraft_type, bool(airline_name or airline_code))

    return {
        "icao24": icao24,
        "callsign": callsign,
        "airline": airline_name,
        "airlineCode": airline_code,
        "type": aircraft_type,
        "reg": reg,
        "kind": kind,
        "fromCode": from_code,
        "fromCity": from_city,
        "fromCountry": from_country,
        "toCode": to_code,
        "toCity": to_city,
        "toCountry": to_country,
        "altitudeFt": _meters_to_feet(geo_alt if geo_alt is not None else baro_alt),
        "speedKt": _meters_per_sec_to_knots(velocity),
        "verticalRateFpm": _meters_per_sec_to_fpm(vertical_rate),
        "onGround": on_ground,
        "trackDeg": round(true_track) if true_track is not None else None,
        "bearingDeg": bearing_deg,
        "distanceKm": distance_km,
        "lat": lat,
        "lon": lon,
    }


# ---------------------------------------------------------------------------
# /api/flights/nearby
# ---------------------------------------------------------------------------

@router.get("/nearby")
async def nearby_aircraft(latitude: float, longitude: float, limit: int = 15) -> dict[str, Any]:
    client = get_http_client()
    states: list[list[Any]] = []
    used_radius = SEARCH_RADII[-1]
    for radius in SEARCH_RADII:
        used_radius = radius
        states = await fetch_states_in_radius(client, latitude, longitude, radius)
        if states:
            break

    candidates: list[tuple[float, list[Any]]] = []
    for row in states:
        if not isinstance(row, list) or len(row) < 17:
            continue
        lat, lon = row[6], row[5]
        if lat is None or lon is None:
            continue
        candidates.append((haversine(latitude, longitude, lat, lon), row))

    candidates.sort(key=lambda item: item[0])
    top_rows = [row for _, row in candidates[:limit]]

    aircraft = list(
        await asyncio.gather(
            *(build_aircraft_entry(client, row, latitude, longitude) for row in top_rows)
        )
    )

    return {
        "home": {"lat": latitude, "lon": longitude, "rangeKm": used_radius},
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "aircraft": aircraft,
    }


# ---------------------------------------------------------------------------
# /api/flights/track
# ---------------------------------------------------------------------------

class TrackRequest(BaseModel):
    query: str


def _empty_track_context() -> dict[str, Any]:
    return {
        "query": None,
        "mode": None,
        "flight": None,
        "route": None,
        "schedule": {},
        "progress": 0.0,
        "etaLine": None,
        "awaitReason": None,
    }


async def _clear_pins(query: str | None = None) -> None:
    """Drop one pin, or every pin when no query is given."""
    async with _track_lock:
        if query is None:
            _track.clear()
            return
        _track.pop(normalize_query(query)[0], None)


def _format_eta(hours_left: float) -> str:
    eta_dt = datetime.now().astimezone() + timedelta(hours=hours_left)
    minutes_left = round(hours_left * 60)
    try:
        time_label = eta_dt.strftime("%-I:%M %p")
    except ValueError:  # pragma: no cover - non-POSIX strftime fallback
        time_label = eta_dt.strftime("%I:%M %p").lstrip("0")
    return f"ETA ~{time_label} · {minutes_left} min left"


def await_reason(
    icao_callsign: str,
    icao24: str | None,
    has_route: bool,
    has_schedule_key: bool,
    feed_failing: bool = False,
    has_opensky_key: bool = False,
) -> str:
    """Why a pinned flight has no live position, in the terms the person pinning it can act on.

    "Awaiting" on its own is indistinguishable from a bug, and the most common cause is not one:
    a flight number sold by one airline and flown by another transmits the *operating* airline's
    callsign, so nothing in the sky is broadcasting the number that was typed. Position-by-number
    matching (`operated_by`) recovers the affiliate case, where the number is kept; a true codeshare
    renumbers the flight and only a schedule feed can connect the two.
    """
    # A failing feed explains any of the cases below, and is the only one the flight itself is not
    # responsible for, so it is said first rather than blaming the flight for the outage.
    if feed_failing:
        return (
            "The position feed is not answering right now"
            + ("." if has_opensky_key else
               " — anonymous OpenSky is rate-limited; add OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET for a higher limit.")
        )
    if icao24:
        return f"{icao_callsign} is known but its aircraft has not reported a position recently."
    if has_route and not has_schedule_key:
        return (
            f"No aircraft is transmitting {icao_callsign}. If this is a codeshare it is flying "
            "under the operating airline's own callsign — set AIRLABS_KEY to follow those."
        )
    if has_route:
        return f"No aircraft is transmitting {icao_callsign}; the schedule feed has no live position for it either."
    return f"No aircraft is transmitting {icao_callsign} right now, and no route is on file for it."


def _pin_is_expired(pin: dict[str, Any], now: float) -> bool:
    """A pin retires once the flight has concluded, never merely because it went quiet.

    Losing the aircraft from OpenSky's state vector is routine -- coverage gaps, a transponder
    between updates -- so a pin that has been seen airborne is kept until it lands and the linger
    window passes. Only a pin that never produced a single position is given up on, and then only
    after long enough that a flight pinned before pushback still gets tracked.
    """
    landed_at = pin.get("landed_at")
    if landed_at is not None:
        return (now - landed_at) > TRACK_LINGER_S
    if pin.get("seen_at") is None:
        return (now - pin["pinned_at"]) > TRACK_UNSEEN_S
    return False


async def _build_pin_context(client: httpx.AsyncClient, pin: dict[str, Any]) -> dict[str, Any]:
    query = pin["query"]
    icao_callsign = pin["icao_callsign"]
    key = pin["key"]

    schedule = await resolve_schedule(client, pin["iata_number"])
    airlabs_icao24 = schedule.pop("_icao24", None)
    # A true codeshare flies under the operating airline's own callsign, so nothing in the sky is
    # broadcasting the number that was typed. The schedule sources know the real callsign, which
    # makes those flights findable instead of stuck on "Awaiting".
    schedule_callsign = schedule.pop("_callsign", None)

    # Fetched before the aircraft rather than after it: the scheduled endpoints are what a
    # partner-operated match is checked against, and the lookup is cached either way.
    route = await adsbdb_route_lookup(client, icao_callsign) if icao_callsign else None
    db_origin = _airport_obj(route.get("origin")) if route else None
    db_dest = _airport_obj(route.get("destination")) if route else None

    # The schedule names today's actual city pair, where adsbdb only has a historical mapping for
    # the flight number. It therefore wins for a pinned flight, and also gives the corridor check
    # below something to work with when adsbdb has nothing at all.
    sched_origin = _schedule_airport(schedule.get("fromCode"), schedule.get("fromCity"))
    sched_dest = _schedule_airport(schedule.get("toCode"), schedule.get("toCity"))

    # The schedule names the airports but carries no coordinates, and `AIRPORTS` only covers
    # fields near home -- so a long-haul route had no geometry to draw. This keyless worldwide
    # lookup fills the coordinates in for either end that is still missing them.
    if (sched_origin and sched_origin["lat"] is None) or (sched_dest and sched_dest["lat"] is None) or not (sched_origin and sched_dest):
        geo = await flight_sources.route_with_coordinates(
            client, schedule_callsign or icao_callsign, _note_upstream
        )
        if geo:
            geo_origin, geo_dest = geo
            sched_origin = _merge_airport(sched_origin, geo_origin)
            sched_dest = _merge_airport(sched_dest, geo_dest)

    if sched_origin and sched_dest:
        db_origin, db_dest = sched_origin, sched_dest

    icao24 = pin["icao24"]
    # A hex that has stopped returning a state vector may simply be the wrong aircraft: callsigns
    # get reused daily, so re-resolve rather than let one bad lookup strand the flight in "await".
    stale_hex = (
        icao24 is not None
        and pin["seen_at"] is None
        and (time.time() - pin["resolved_at"]) > TRACK_RERESOLVE_S
    )
    if not icao24 or stale_hex:
        resolved = airlabs_icao24 or await resolve_icao24_by_callsign(
            client, icao_callsign, db_origin, db_dest,
        )
        if not resolved and schedule_callsign and schedule_callsign != icao_callsign:
            resolved = await resolve_icao24_by_callsign(
                client, schedule_callsign, db_origin, db_dest,
            )
        if resolved:
            icao24 = resolved
            async with _track_lock:
                if key in _track:
                    _track[key]["icao24"] = resolved
                    _track[key]["resolved_at"] = time.time()

    state_row = await fetch_state_by_icao24(client, icao24) if icao24 else None

    flight = await build_aircraft_entry(client, state_row) if state_row else None

    p_lat = state_row[6] if state_row else None
    p_lon = state_row[5] if state_row else None
    p_track = state_row[10] if state_row else None
    p_vrate = state_row[11] if state_row else None
    p_alt = (state_row[13] if state_row[13] is not None else state_row[7]) if state_row else None
    has_airline = bool(derive_airline_code(icao_callsign))

    origin, dest = await resolve_route(
        client, route, icao_callsign, icao24, p_lat, p_lon, p_track, p_vrate, p_alt, has_airline,
    )
    # A pinned flight has a schedule naming today's city pair, so an endpoint the live sources
    # could not work out is filled from it rather than left blank. This is what puts a route on
    # screen for a flight that has not taken off yet, where there is no position to infer from.
    origin = origin or sched_origin
    dest = dest or sched_dest

    route_out: dict[str, Any] | None = None
    progress = 0.0
    eta_line: str | None = None

    on_ground = bool(state_row[8]) if state_row else None
    mode = "await"
    if state_row is not None:
        mode = "landed" if on_ground else "track"
    # A live airborne aircraft outranks the schedule feed, which reports the same flight number's
    # previous leg as "landed" and would otherwise retire a flight that has only just taken off.
    if mode != "track" and schedule.get("status") in ("landed", "arrived"):
        mode = "landed"

    # Show whatever side is known -- e.g. destination alone from live descent inference, with the
    # origin still unresolved -- rather than nothing until both sides agree.
    route_out = route_payload(origin, dest)

    if origin and dest:
        o_lat, o_lon = origin.get("lat"), origin.get("lon")
        d_lat, d_lon = dest.get("lat"), dest.get("lon")
        if None not in (o_lat, o_lon, d_lat, d_lon) and p_lat is not None and p_lon is not None:
            route_km = haversine(o_lat, o_lon, d_lat, d_lon)
            d_from = haversine(o_lat, o_lon, p_lat, p_lon)
            d_to = haversine(p_lat, p_lon, d_lat, d_lon)
            stale = (d_from + d_to) > route_km * 1.6 + 60
            if not stale and (d_from + d_to) > 0:
                frac = d_from / (d_from + d_to)
                progress = max(0.0, min(1.0, frac))

                velocity = state_row[9]
                speed_kt = _meters_per_sec_to_knots(velocity)
                if mode == "track" and speed_kt is not None and speed_kt > 30:
                    speed_kmh = velocity * 3.6
                    if speed_kmh > 0:
                        eta_line = _format_eta(d_to / speed_kmh)

    async with _track_lock:
        live = _track.get(key)
        if live is not None:
            if state_row is not None:
                live["seen_at"] = time.time()
            if mode == "landed":
                live["landed_at"] = live["landed_at"] or time.time()
            else:
                live["landed_at"] = None

    return {
        "query": query,
        "mode": mode,
        "flight": flight,
        "route": route_out,
        "schedule": schedule,
        "progress": round(progress, 4),
        "etaLine": eta_line,
        "awaitReason": (
            await_reason(
                icao_callsign,
                icao24,
                bool(route_out),
                bool(os.getenv("AIRLABS_KEY")),
                upstream_failing("opensky_states"),
                bool(os.getenv("OPENSKY_CLIENT_ID") and os.getenv("OPENSKY_CLIENT_SECRET")),
            )
            if mode == "await" else None
        ),
    }


async def _build_track_board() -> dict[str, Any]:
    """Every pinned flight, plus the first one flattened for callers that expect a single flight."""
    now = time.time()
    async with _track_lock:
        for key in [k for k, pin in _track.items() if _pin_is_expired(pin, now)]:
            del _track[key]
        pins = [dict(pin) for pin in _track.values()]

    if not pins:
        return {**_empty_track_context(), "flights": []}

    async with _SharedClient() as client:
        flights = list(await asyncio.gather(*(_build_pin_context(client, pin) for pin in pins)))

    return {**flights[0], "flights": flights}


@router.post("/track")
async def pin_track(body: TrackRequest) -> dict[str, Any]:
    query = body.query.strip()
    icao_callsign, iata_number = normalize_query(query)
    if not icao_callsign:
        return await _build_track_board()

    async with _track_lock:
        if icao_callsign not in _track and len(_track) >= MAX_TRACKED_FLIGHTS:
            # Oldest pin makes way, so pinning never silently does nothing once the board is full.
            del _track[next(iter(_track))]
        _track[icao_callsign] = {
            "key": icao_callsign,
            "query": query,
            "icao_callsign": icao_callsign,
            "iata_number": iata_number,
            "icao24": None,
            "resolved_at": 0.0,
            "pinned_at": time.time(),
            "seen_at": None,
            "landed_at": None,
        }
    return await _build_track_board()


@router.delete("/track")
async def unpin_track(query: str | None = None) -> dict[str, Any]:
    await _clear_pins(query)
    return await _build_track_board()


@router.get("/track")
async def get_track() -> dict[str, Any]:
    return await _build_track_board()


# ---------------------------------------------------------------------------
# /api/flights/status  (diagnostics)
# ---------------------------------------------------------------------------

@router.get("/status")
async def flights_status() -> dict[str, Any]:
    """Which upstreams are configured and reachable right now.

    Every fetch above degrades to empty on failure, so a blank flight board looks identical
    whether the sky is quiet, a key is missing, or OpenSky is rate-limiting. This endpoint is
    the one place that says which it is.
    """
    has_opensky = bool(os.getenv("OPENSKY_CLIENT_ID") and os.getenv("OPENSKY_CLIENT_SECRET"))
    has_airlabs = bool(os.getenv("AIRLABS_KEY"))

    token_ok = False
    states_ok = False
    if has_opensky:
        async with _SharedClient() as client:
            token_ok = bool(await get_opensky_token(client))
            if token_ok:
                headers = await _opensky_headers(client)
                try:
                    probe = await client.get(
                        OPENSKY_STATES_URL,
                        params={"lamin": 30.0, "lomin": -98.0, "lamax": 31.0, "lomax": -97.0},
                        headers=headers,
                        timeout=15,
                    )
                    states_ok = probe.status_code == 200
                    if not states_ok:
                        _note_upstream("opensky_states", f"HTTP {probe.status_code}")
                except httpx.HTTPError as error:
                    _note_upstream("opensky_states", str(error))

    return {
        "opensky": {
            "configured": has_opensky,
            "tokenOk": token_ok,
            "statesOk": states_ok,
            # Route history needs the credentialed endpoint; anonymous access cannot reach it.
            "historyAvailable": has_opensky,
        },
        "airlabs": {
            "configured": has_airlabs,
            **flight_sources.budget.snapshot()["airlabs"],
        },
        # Keyless fallbacks need no configuration, so what matters is which one is actually
        # carrying the board right now -- that is the difference between "OpenSky is down" and
        # "OpenSky is down and it doesn't matter".
        "fallback": {
            "positionSource": _active_position_source["name"],
            "activeRecently": bool(_active_position_source["at"])
            and (time.time() - _active_position_source["at"]) < UPSTREAM_STALE_S,
            "feeds": [name for name, *_ in flight_sources.ADSB_FEEDS],
            "scheduleBudget": flight_sources.budget.snapshot()["flightstats"],
        },
        "lastErrors": {
            source: {"detail": entry["detail"], "ageSeconds": round(time.time() - entry["at"])}
            for source, entry in _last_upstream_error.items()
        },
    }
