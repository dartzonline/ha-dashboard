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
import math
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/flights")

# ---------------------------------------------------------------------------
# Upstream endpoints
# ---------------------------------------------------------------------------

OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all"
OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
)
ADSBDB_BASE_URL = "https://api.adsbdb.com/v0"
AIRLABS_FLIGHT_URL = "https://airlabs.co/api/v9/flight"

# Expanding bbox search radii (km), mirrors the source project's SEARCH_RADII.
SEARCH_RADII: list[float] = [120, 300, 700]

# Cache TTLs (seconds), mirroring the source project's cache lifetimes.
STATES_CACHE_TTL = 60.0
ROUTE_CACHE_TTL = 3600.0
AIRCRAFT_CACHE_TTL = 86400.0
TRACK_LINGER_S = 600.0

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
        "pc-12", "tbm", "pilatus", "saab 340", "beech 1900", "metroliner", "do228",
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

# key: (round(lat, 2), round(lon, 2), radius_km) -> (fetched_at, states)
_states_cache: dict[tuple[float, float, float], tuple[float, list[Any]]] = {}

# key: callsign (upper) -> (fetched_at, adsbdb flightroute dict | None)
_route_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

# key: icao24 (lower) -> (fetched_at, adsbdb aircraft dict | None)
_aircraft_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

# Pinned-flight tracking state, guarded by asyncio.Lock (single async process).
_track: dict[str, Any] = {
    "query": None,
    "icao_callsign": None,
    "iata_number": None,
    "icao24": None,
    "landed_at": None,
}
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
    text = (type_str or "").strip().lower()
    if not text:
        return "jet" if has_airline else "light"
    for kind, needles in CLASSIFIER_GROUPS:
        for needle in needles:
            if needle in text:
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
        except (httpx.HTTPError, ValueError):
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
    """Bbox states query around (lat, lon), cached ~60s per rounded lat/lon+radius."""
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
    except (httpx.HTTPError, ValueError):
        states = []

    _states_cache[key] = (now, states)
    return states


async def fetch_state_by_icao24(client: httpx.AsyncClient, icao24: str) -> list[Any] | None:
    headers = await _opensky_headers(client)
    try:
        response = await client.get(
            OPENSKY_STATES_URL, params={"icao24": icao24.lower()}, headers=headers, timeout=15
        )
        response.raise_for_status()
        payload = response.json()
        states = payload.get("states") or []
    except (httpx.HTTPError, ValueError):
        return None
    return states[0] if states else None


async def resolve_icao24_by_callsign(client: httpx.AsyncClient, callsign: str | None) -> str | None:
    """One-time full-states scan filtered by callsign; caller should cache the result."""
    if not callsign:
        return None
    headers = await _opensky_headers(client)
    try:
        response = await client.get(OPENSKY_STATES_URL, headers=headers, timeout=15)
        response.raise_for_status()
        payload = response.json()
        states = payload.get("states") or []
    except (httpx.HTTPError, ValueError):
        return None

    target = callsign.strip().upper()
    for row in states:
        if not isinstance(row, list) or len(row) < 2:
            continue
        cs = (row[1] or "").strip().upper() if row[1] else ""
        if cs == target:
            return row[0]
    return None


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


async def adsbdb_aircraft_lookup(client: httpx.AsyncClient, icao24: str) -> dict[str, Any] | None:
    key = icao24.strip().lower()
    now = time.time()
    cached = _aircraft_cache.get(key)
    if cached and now - cached[0] < AIRCRAFT_CACHE_TTL:
        return cached[1]

    result: dict[str, Any] | None = None
    try:
        response = await client.get(f"{ADSBDB_BASE_URL}/aircraft/{key}", timeout=10)
        if response.status_code == 200:
            payload = response.json()
            result = (payload.get("response") or {}).get("aircraft")
    except (httpx.HTTPError, ValueError):
        result = None

    _aircraft_cache[key] = (now, result)
    return result


# ---------------------------------------------------------------------------
# AirLabs (optional)
# ---------------------------------------------------------------------------

async def airlabs_schedule(client: httpx.AsyncClient, iata_number: str | None) -> dict[str, Any]:
    """Schedule/delay for one pinned flight. Returns {} whenever unset or empty."""
    api_key = os.getenv("AIRLABS_KEY")
    if not api_key or not iata_number:
        return {}

    try:
        response = await client.get(
            AIRLABS_FLIGHT_URL,
            params={"api_key": api_key, "flight_iata": iata_number},
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
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

    from_code = from_city = from_country = None
    to_code = to_city = to_country = None

    route = await adsbdb_route_lookup(client, callsign) if callsign else None
    if route:
        route_airline = route.get("airline") or {}
        if route_airline.get("name"):
            airline_name = route_airline.get("name")
        if route_airline.get("icao"):
            airline_code = route_airline.get("icao")
        origin = route.get("origin") or {}
        dest = route.get("destination") or {}
        from_code = origin.get("iata_code")
        from_city = origin.get("municipality")
        from_country = origin.get("country_name")
        to_code = dest.get("iata_code")
        to_city = dest.get("municipality")
        to_country = dest.get("country_name")

    aircraft_type: str | None = None
    reg: str | None = None
    aircraft_info = await adsbdb_aircraft_lookup(client, icao24) if icao24 else None
    if aircraft_info:
        reg = aircraft_info.get("registration")
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
    async with httpx.AsyncClient(timeout=15) as client:
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
    }


async def _clear_pin() -> None:
    async with _track_lock:
        _track["query"] = None
        _track["icao_callsign"] = None
        _track["iata_number"] = None
        _track["icao24"] = None
        _track["landed_at"] = None


def _format_eta(hours_left: float) -> str:
    eta_dt = datetime.now().astimezone() + timedelta(hours=hours_left)
    minutes_left = round(hours_left * 60)
    try:
        time_label = eta_dt.strftime("%-I:%M %p")
    except ValueError:  # pragma: no cover - non-POSIX strftime fallback
        time_label = eta_dt.strftime("%I:%M %p").lstrip("0")
    return f"ETA ~{time_label} · {minutes_left} min left"


async def _build_track_context() -> dict[str, Any]:
    async with _track_lock:
        query = _track["query"]
        icao_callsign = _track["icao_callsign"]
        iata_number = _track["iata_number"]
        icao24 = _track["icao24"]
        landed_at = _track["landed_at"]

    if not query:
        return _empty_track_context()

    if landed_at is not None and (time.time() - landed_at) > TRACK_LINGER_S:
        await _clear_pin()
        return _empty_track_context()

    async with httpx.AsyncClient(timeout=15) as client:
        schedule = await airlabs_schedule(client, iata_number)
        airlabs_icao24 = schedule.pop("_icao24", None)

        if not icao24:
            icao24 = airlabs_icao24 or await resolve_icao24_by_callsign(client, icao_callsign)
            if icao24:
                async with _track_lock:
                    if _track["query"] == query:
                        _track["icao24"] = icao24

        state_row = await fetch_state_by_icao24(client, icao24) if icao24 else None

        flight = await build_aircraft_entry(client, state_row) if state_row else None

        route = await adsbdb_route_lookup(client, icao_callsign) if icao_callsign else None
        route_out: dict[str, Any] | None = None
        progress = 0.0
        eta_line: str | None = None

        on_ground = bool(state_row[8]) if state_row else None
        mode = "await"
        if state_row is not None:
            mode = "landed" if on_ground else "track"
        if schedule.get("status") in ("landed", "arrived"):
            mode = "landed"

        if route:
            origin = route.get("origin") or {}
            dest = route.get("destination") or {}
            route_out = {
                "fromCode": origin.get("iata_code"),
                "fromCity": origin.get("municipality"),
                "toCode": dest.get("iata_code"),
                "toCity": dest.get("municipality"),
            }

            o_lat, o_lon = origin.get("latitude"), origin.get("longitude")
            d_lat, d_lon = dest.get("latitude"), dest.get("longitude")
            if state_row and None not in (o_lat, o_lon, d_lat, d_lon):
                p_lat, p_lon = state_row[6], state_row[5]
                if p_lat is not None and p_lon is not None:
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

        if mode == "landed":
            if landed_at is None:
                async with _track_lock:
                    if _track["query"] == query:
                        _track["landed_at"] = time.time()
        elif landed_at is not None:
            async with _track_lock:
                if _track["query"] == query:
                    _track["landed_at"] = None

    return {
        "query": query,
        "mode": mode,
        "flight": flight,
        "route": route_out,
        "schedule": schedule,
        "progress": round(progress, 4),
        "etaLine": eta_line,
    }


@router.post("/track")
async def pin_track(body: TrackRequest) -> dict[str, Any]:
    icao_callsign, iata_number = normalize_query(body.query)
    async with _track_lock:
        _track["query"] = body.query.strip()
        _track["icao_callsign"] = icao_callsign
        _track["iata_number"] = iata_number
        _track["icao24"] = None
        _track["landed_at"] = None
    return await _build_track_context()


@router.delete("/track")
async def unpin_track() -> dict[str, Any]:
    await _clear_pin()
    return await _build_track_context()


@router.get("/track")
async def get_track() -> dict[str, Any]:
    return await _build_track_context()
