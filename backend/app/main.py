import asyncio
import contextlib
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import connectivity
from .config import load_settings
from .dashboard_config import DashboardConfigPayload, clear_overrides, load_overrides, save_overrides
from .entity_registry import RegistrySnapshot
from .event_bridge import EventBridge
from .flights import close_http_client, get_http_client
from .flights import router as flights_router
from .ha_client import HomeAssistantClient

settings = load_settings()
bridge = EventBridge(settings)
ha_client = HomeAssistantClient(settings)
registry_snapshot = RegistrySnapshot(bridge)

NIGHT_MODE_INDOOR_LIGHTS_DEFAULT = {
    "light.smart_wi_fi_switch_2",
    "light.media_room_media_hue",
    "light.media_room_media_room",
    "light.my_rest_light",
    "light.my_rest_clock",
    "light.chandelier",
}
NIGHT_MODE_PROTECTED_TERMS = {
    "alarm", "appliance", "child_lock", "continuous_monitoring", "do_not_disturb",
    "driveway", "dryer", "dyson", "firmware", "garage", "outdoor", "patio",
    "porch", "refrigerator", "roborock", "safety", "toddler", "vacuum", "washer",
}


class NightModeRequest(BaseModel):
    confirm: bool = False


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(bridge.run())
    if settings.configured:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(bridge.wait_until_connected(), timeout=5)
    yield
    await bridge.stop()
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    await ha_client.close()
    await close_http_client()


app = FastAPI(title="Home Panel", version="1.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(flights_router)


def get_client() -> HomeAssistantClient:
    return ha_client


def require_configuration() -> None:
    if not settings.configured:
        raise HTTPException(503, "Set HA_URL and HA_TOKEN, or run as a Home Assistant add-on")


def upstream_error(error: httpx.HTTPError) -> HTTPException:
    status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else 502
    return HTTPException(status, "Home Assistant request failed")


def weather_upstream_error(error: httpx.HTTPError) -> HTTPException:
    status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else 502
    return HTTPException(status, "External weather request failed")


def entity_name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes")
    friendly_name = attributes.get("friendly_name", "") if isinstance(attributes, dict) else ""
    return f"{entity.get('entity_id', '')} {friendly_name}".lower().replace(" ", "_")


def safe_lighting_switch(entity: dict[str, Any]) -> bool:
    entity_id = str(entity.get("entity_id", ""))
    searchable = entity_name(entity)
    return (
        entity_id.startswith("switch.")
        and entity.get("state") == "on"
        and any(term in searchable for term in ("light", "lighting", "lamp"))
        and not any(term in searchable for term in NIGHT_MODE_PROTECTED_TERMS)
    )


async def run_group(
    client: HomeAssistantClient,
    domain: str,
    service: str,
    entity_ids: list[str],
    completed: list[str],
    failures: list[dict[str, str]],
) -> None:
    if not entity_ids:
        return
    try:
        await client.call_service(domain, service, {"entity_id": entity_ids})
        completed.extend(entity_ids)
    except httpx.HTTPError as error:
        failures.append({"action": f"{domain}.{service}", "detail": str(upstream_error(error).detail)})


def weather_code_label(code: int) -> str:
    labels = {
        0: "clear sky",
        1: "mainly clear",
        2: "partly cloudy",
        3: "overcast",
        45: "fog",
        48: "depositing rime fog",
        51: "light drizzle",
        53: "drizzle",
        55: "dense drizzle",
        56: "light freezing drizzle",
        57: "dense freezing drizzle",
        61: "slight rain",
        63: "rain",
        65: "heavy rain",
        66: "light freezing rain",
        67: "heavy freezing rain",
        71: "slight snowfall",
        73: "snowfall",
        75: "heavy snowfall",
        77: "snow grains",
        80: "slight rain showers",
        81: "rain showers",
        82: "violent rain showers",
        85: "slight snow showers",
        86: "heavy snow showers",
        95: "thunderstorm",
        96: "thunderstorm with hail",
        99: "thunderstorm with heavy hail",
    }
    return labels.get(code, "unknown")


def build_hourly_rows(hourly: dict[str, list[Any]]) -> list[dict[str, Any]]:
    times = hourly.get("time", [])
    temperatures = hourly.get("temperature_2m", [])
    rain_probabilities = hourly.get("precipitation_probability", [])
    precipitation = hourly.get("precipitation", [])
    codes = hourly.get("weather_code", [])
    uv_index = hourly.get("uv_index", [])
    wind_speeds = hourly.get("wind_speed_10m", [])

    rows: list[dict[str, Any]] = []
    for idx, time_value in enumerate(times):
        rows.append(
            {
                "time": time_value,
                "temperature": temperatures[idx] if idx < len(temperatures) else None,
                "rainChance": rain_probabilities[idx] if idx < len(rain_probabilities) else None,
                "precipitation": precipitation[idx] if idx < len(precipitation) else None,
                "weatherCode": codes[idx] if idx < len(codes) else None,
                "condition": weather_code_label(int(codes[idx])) if idx < len(codes) and isinstance(codes[idx], (int, float)) else "unknown",
                "uv": uv_index[idx] if idx < len(uv_index) else None,
                "windSpeed": wind_speeds[idx] if idx < len(wind_speeds) else None,
            }
        )
    return rows


def build_daily_rows(daily: dict[str, list[Any]]) -> list[dict[str, Any]]:
    dates = daily.get("time", [])
    max_temps = daily.get("temperature_2m_max", [])
    min_temps = daily.get("temperature_2m_min", [])
    rain_sum = daily.get("precipitation_sum", [])
    rain_probability_max = daily.get("precipitation_probability_max", [])
    uv_max = daily.get("uv_index_max", [])
    codes = daily.get("weather_code", [])
    sunrise = daily.get("sunrise", [])
    sunset = daily.get("sunset", [])

    rows: list[dict[str, Any]] = []
    for idx, date_value in enumerate(dates):
        code_value = codes[idx] if idx < len(codes) else None
        rows.append(
            {
                "date": date_value,
                "temperatureMax": max_temps[idx] if idx < len(max_temps) else None,
                "temperatureMin": min_temps[idx] if idx < len(min_temps) else None,
                "rainTotal": rain_sum[idx] if idx < len(rain_sum) else None,
                "rainChance": rain_probability_max[idx] if idx < len(rain_probability_max) else None,
                "uvMax": uv_max[idx] if idx < len(uv_max) else None,
                "weatherCode": code_value,
                "condition": weather_code_label(int(code_value)) if isinstance(code_value, (int, float)) else "unknown",
                "sunrise": sunrise[idx] if idx < len(sunrise) else None,
                "sunset": sunset[idx] if idx < len(sunset) else None,
            }
        )
    return rows


@app.get("/api/health")
async def health(client: HomeAssistantClient = Depends(get_client)) -> dict[str, Any]:
    connected = bridge.connected if settings.configured else await client.health()
    return {
        "status": "ok" if connected else "degraded",
        "home_assistant": {"configured": settings.configured, "connected": connected},
    }


def default_energy_rate() -> float:
    """Fallback $/kWh when nobody has set one, overridable per install without a rebuild."""
    try:
        return float(os.getenv("ENERGY_RATE_PER_KWH", "") or 0.15)
    except ValueError:
        return 0.15


def config_response(overrides: dict[str, Any]) -> dict[str, Any]:
    return {
        "sections": overrides.get("sections"),
        "nightModeIndoorLights": overrides.get("nightModeIndoorLights") or sorted(NIGHT_MODE_INDOOR_LIGHTS_DEFAULT),
        "energyRatePerKwh": overrides.get("energyRatePerKwh") or default_energy_rate(),
        "ignoredEntityIds": overrides.get("ignoredEntityIds") or [],
    }


@app.get("/api/config")
async def get_dashboard_config() -> dict[str, Any]:
    return config_response(load_overrides())


@app.put("/api/config")
async def put_dashboard_config(payload: DashboardConfigPayload) -> dict[str, Any]:
    return config_response(save_overrides(payload))


@app.delete("/api/config")
async def delete_dashboard_config() -> dict[str, Any]:
    clear_overrides()
    return config_response({})


@app.get("/api/states", dependencies=[Depends(require_configuration)])
async def states(client: HomeAssistantClient = Depends(get_client)) -> list[dict[str, Any]]:
    try:
        return await client.states()
    except httpx.HTTPError as error:
        raise upstream_error(error) from error


@app.get("/api/states/{entity_id}", dependencies=[Depends(require_configuration)])
async def state(entity_id: str, client: HomeAssistantClient = Depends(get_client)) -> dict[str, Any]:
    try:
        return await client.state(entity_id)
    except httpx.HTTPError as error:
        raise upstream_error(error) from error


@app.get("/api/registry", dependencies=[Depends(require_configuration)])
async def registry() -> dict[str, Any]:
    """Joined entity/device/area registry metadata -- see docs/auto-entity-discovery.md.

    Consumed by useEntityDiscovery to tell a diagnostic sensor apart from a tile worth proposing;
    `/api/states` carries none of that, which is why this goes over the WebSocket API instead.
    """
    try:
        return await registry_snapshot.get()
    except (RuntimeError, TimeoutError) as error:
        raise HTTPException(502, f"Home Assistant registry request failed: {error}") from error


@app.get("/api/entity-picture/{entity_id}", dependencies=[Depends(require_configuration)])
async def entity_picture(entity_id: str, client: HomeAssistantClient = Depends(get_client)) -> Response:
    try:
        entity = await client.state(entity_id)
    except httpx.HTTPError as error:
        raise upstream_error(error) from error

    picture = entity.get("attributes", {}).get("entity_picture")
    if not picture:
        raise HTTPException(404, "Entity has no picture")

    try:
        response = await client.raw_get(picture)
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise upstream_error(error) from error

    media_type = response.headers.get("content-type", "image/jpeg")
    return Response(content=response.content, media_type=media_type)


@app.get("/api/weather/external")
async def external_weather(latitude: float, longitude: float, units: str = "imperial") -> dict[str, Any]:
    # open-meteo answers in Celsius/km-h/mm unless told otherwise, which put 27° next to the
    # dashboard's own 81 °F on the same screen. The caller states which system it renders in.
    imperial = units.lower() != "metric"
    query = {
        "latitude": latitude,
        "longitude": longitude,
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
        "precipitation_unit": "inch" if imperial else "mm",
        "current": ",".join(
            [
                "temperature_2m",
                "relative_humidity_2m",
                "apparent_temperature",
                "precipitation",
                "weather_code",
                "wind_speed_10m",
                "wind_gusts_10m",
                "uv_index",
                "is_day",
            ]
        ),
        "hourly": ",".join(
            [
                "temperature_2m",
                "precipitation_probability",
                "precipitation",
                "weather_code",
                "uv_index",
                "wind_speed_10m",
            ]
        ),
        "daily": ",".join(
            [
                "weather_code",
                "temperature_2m_max",
                "temperature_2m_min",
                "precipitation_sum",
                "precipitation_probability_max",
                "uv_index_max",
                "sunrise",
                "sunset",
            ]
        ),
        "timezone": "auto",
        "forecast_days": 7,
    }

    url = f"https://api.open-meteo.com/v1/forecast?{urlencode(query)}"
    try:
        # Shared, keep-alive client rather than a fresh connection per call -- every open city
        # weather sheet and the Weather section's own poll hit this endpoint repeatedly.
        response = await get_http_client().get(url, timeout=8)
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise weather_upstream_error(error) from error

    payload = response.json()
    current = payload.get("current", {}) if isinstance(payload, dict) else {}
    hourly = payload.get("hourly", {}) if isinstance(payload, dict) else {}
    daily = payload.get("daily", {}) if isinstance(payload, dict) else {}

    hourly_rows = build_hourly_rows(hourly if isinstance(hourly, dict) else {})
    daily_rows = build_daily_rows(daily if isinstance(daily, dict) else {})
    current_weather_code = current.get("weather_code")

    return {
        "provider": "open-meteo",
        "units": "imperial" if imperial else "metric",
        "temperatureUnit": "°F" if imperial else "°C",
        "windUnit": "mph" if imperial else "km/h",
        "precipitationUnit": "in" if imperial else "mm",
        "latitude": payload.get("latitude"),
        "longitude": payload.get("longitude"),
        "timezone": payload.get("timezone"),
        "current": {
            "time": current.get("time"),
            "temperature": current.get("temperature_2m"),
            "apparentTemperature": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "precipitation": current.get("precipitation"),
            "windSpeed": current.get("wind_speed_10m"),
            "windGusts": current.get("wind_gusts_10m"),
            "uv": current.get("uv_index"),
            "isDay": current.get("is_day"),
            "weatherCode": current_weather_code,
            "condition": weather_code_label(int(current_weather_code)) if isinstance(current_weather_code, (int, float)) else "unknown",
        },
        "hourly": hourly_rows,
        "daily": daily_rows,
    }


@app.post("/api/services/{domain}/{service}", dependencies=[Depends(require_configuration)])
async def call_service(
    domain: str,
    service: str,
    data: dict[str, Any],
    client: HomeAssistantClient = Depends(get_client),
) -> list[dict[str, Any]]:
    try:
        if settings.configured:
            return await bridge.call_service(domain, service, data)
        return await client.call_service(domain, service, data)
    except (httpx.HTTPError, ConnectionError, RuntimeError, asyncio.TimeoutError) as error:
        if not isinstance(error, httpx.HTTPError):
            raise HTTPException(502, str(error)) from error
        raise upstream_error(error) from error


@app.post("/api/actions/night-mode", dependencies=[Depends(require_configuration)])
async def night_mode(
    request: NightModeRequest,
    client: HomeAssistantClient = Depends(get_client),
) -> dict[str, Any]:
    if not request.confirm:
        raise HTTPException(400, "Night Mode requires explicit confirmation")

    try:
        all_states = await client.states()
    except httpx.HTTPError as error:
        raise upstream_error(error) from error

    unavailable_states = {"unavailable", "unknown"}
    locks = [
        str(entity["entity_id"])
        for entity in all_states
        if str(entity.get("entity_id", "")).startswith("lock.")
        and entity.get("state") not in unavailable_states | {"locked"}
    ]
    skipped_locks = [
        str(entity["entity_id"])
        for entity in all_states
        if str(entity.get("entity_id", "")).startswith("lock.")
        and entity.get("state") in unavailable_states
    ]
    garages = [
        str(entity["entity_id"])
        for entity in all_states
        if str(entity.get("entity_id", "")).startswith("cover.")
        and entity.get("state") in {"open", "opening"}
        and (
            str(entity.get("attributes", {}).get("device_class", "")) == "garage"
            or "garage" in entity_name(entity)
            or "garrage" in entity_name(entity)
        )
    ]
    indoor_lights = set(load_overrides().get("nightModeIndoorLights") or NIGHT_MODE_INDOOR_LIGHTS_DEFAULT)
    lights = [
        str(entity["entity_id"])
        for entity in all_states
        if entity.get("entity_id") in indoor_lights and entity.get("state") == "on"
    ]
    switches = [str(entity["entity_id"]) for entity in all_states if safe_lighting_switch(entity)]

    locked: list[str] = []
    garages_closed: list[str] = []
    lights_off: list[str] = []
    switches_off: list[str] = []
    failures: list[dict[str, str]] = []
    await run_group(client, "lock", "lock", locks, locked, failures)
    await run_group(client, "cover", "close_cover", garages, garages_closed, failures)
    await run_group(client, "light", "turn_off", lights, lights_off, failures)
    await run_group(client, "switch", "turn_off", switches, switches_off, failures)

    return {
        "status": "partial" if failures else "completed",
        "locked": locked,
        "garagesClosed": garages_closed,
        "lightsTurnedOff": lights_off,
        "switchesTurnedOff": switches_off,
        "skippedUnavailableLocks": skipped_locks,
        "failures": failures,
    }


def _parse_history_point(row: dict[str, Any]) -> tuple[float, str] | None:
    stamp = row.get("last_changed") or row.get("last_updated")
    if not isinstance(stamp, str):
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp(), str(row.get("state", ""))


def _hour_bucket(timestamp: float) -> int:
    return int(timestamp // 3600) * 3600


@app.get("/api/insights/network", dependencies=[Depends(require_configuration)])
async def network_insights(
    hours: int = 24,
    client: HomeAssistantClient = Depends(get_client),
) -> dict[str, Any]:
    """Hourly average download/upload speed and connected-device count over the recent window.

    Home Assistant has no "clients online" sensor -- the router publishes one device_tracker per
    client instead -- so the count is reconstructed by replaying those trackers' state changes and
    counting how many were `home` during each hour.
    """
    window = max(1, min(hours, 168))
    try:
        all_states = await client.states()
    except httpx.HTTPError as error:
        raise upstream_error(error) from error

    speed_ids = [
        entity_id
        for entity_id in ("sensor.cbr750_gateway_download_speed", "sensor.cbr750_gateway_upload_speed")
        if any(entity.get("entity_id") == entity_id for entity in all_states)
    ]
    tracker_ids = [
        str(entity["entity_id"])
        for entity in all_states
        if str(entity.get("entity_id", "")).startswith("device_tracker.")
    ]

    # Connectivity signals for outage detection. The WAN binary_sensor is the
    # direct answer; the external IP corroborates a reconnect that the polled
    # sensor may have slept through. Device-tracker connectivity sensors are
    # deliberately excluded -- a `connectivity` device_class on some gadget
    # tracks *that gadget's* wifi, not the internet, and flapping IoT devices
    # would otherwise register as internet outages.
    wan_ids = [
        entity_id
        for entity_id in ("binary_sensor.cbr750_gateway_wan_status",)
        if any(entity.get("entity_id") == entity_id for entity in all_states)
    ]
    ip_ids = [
        entity_id
        for entity_id in ("sensor.cbr750_gateway_external_ip",)
        if any(entity.get("entity_id") == entity_id for entity in all_states)
    ]

    requested = speed_ids + wan_ids + ip_ids + tracker_ids
    series: list[list[dict[str, Any]]] = []
    if requested:
        try:
            series = await client.history_many(requested, window)
        except httpx.HTTPError as error:
            raise upstream_error(error) from error

    by_entity: dict[str, list[dict[str, Any]]] = {}
    for rows in series:
        if not rows:
            continue
        entity_id = str(rows[0].get("entity_id", ""))
        if entity_id:
            by_entity[entity_id] = rows

    now = datetime.now(timezone.utc).timestamp()
    first_bucket = _hour_bucket(now - window * 3600)
    buckets = [first_bucket + index * 3600 for index in range(window + 1)]

    def speed_averages(entity_id: str) -> dict[int, float]:
        totals: dict[int, list[float]] = {}
        for row in by_entity.get(entity_id, []):
            parsed = _parse_history_point(row)
            if not parsed:
                continue
            moment, raw = parsed
            try:
                value = float(raw)
            except ValueError:
                continue
            # The router reports KiB/s; the dashboard speaks Mbps everywhere else.
            totals.setdefault(_hour_bucket(moment), []).append(value * 8 / 1024)
        return {bucket: sum(values) / len(values) for bucket, values in totals.items() if values}

    downloads = speed_averages("sensor.cbr750_gateway_download_speed")
    uploads = speed_averages("sensor.cbr750_gateway_upload_speed")

    # Walk each tracker's timeline once, marking the buckets it spent at home. A tracker that never
    # changes state inside the window still counts, because its first row carries the state it
    # already held when the window opened.
    home_per_bucket: dict[int, int] = {bucket: 0 for bucket in buckets}
    for entity_id in tracker_ids:
        points = sorted(
            (point for point in (_parse_history_point(row) for row in by_entity.get(entity_id, [])) if point),
            key=lambda item: item[0],
        )
        if not points:
            continue
        cursor = 0
        state = points[0][1]
        for bucket in buckets:
            while cursor < len(points) and points[cursor][0] <= bucket + 3600:
                state = points[cursor][1]
                cursor += 1
            if state == "home":
                home_per_bucket[bucket] += 1

    points_out = [
        {
            "time": datetime.fromtimestamp(bucket, timezone.utc).isoformat().replace("+00:00", "Z"),
            "downloadMbps": round(downloads[bucket], 2) if bucket in downloads else None,
            "uploadMbps": round(uploads[bucket], 2) if bucket in uploads else None,
            "devices": home_per_bucket.get(bucket, 0),
        }
        for bucket in buckets
    ]

    download_values = [value for value in downloads.values()]
    upload_values = [value for value in uploads.values()]
    device_values = [home_per_bucket[bucket] for bucket in buckets]

    def summarize(values: list[float]) -> dict[str, float | None]:
        if not values:
            return {"average": None, "min": None, "max": None}
        return {
            "average": round(sum(values) / len(values), 2),
            "min": round(min(values), 2),
            "max": round(max(values), 2),
        }

    # Outages, merged across every signal that saw one. Built from the same
    # history payload already fetched above, so this costs no extra round trip.
    spans: list[dict[str, Any]] = []
    for entity_id in wan_ids:
        spans += connectivity.outages_from_binary(by_entity.get(entity_id, []), now, "wan")
    for entity_id in speed_ids:
        spans += connectivity.outages_from_gaps(by_entity.get(entity_id, []), now, "throughput")
    ip_events = connectivity.ip_changes(by_entity.get("sensor.cbr750_gateway_external_ip", []))

    reference = by_entity.get(speed_ids[0], []) if speed_ids else []
    observed_start, _ = connectivity.data_coverage(reference, now - window * 3600, now)
    connectivity_summary = connectivity.summarize(
        connectivity.merge_spans(spans),
        window_start=now - window * 3600,
        now=now,
        ip_events=ip_events,
        resolution_seconds=connectivity.poll_interval(reference),
        observed_start=observed_start,
    )
    wan_state = next(
        (str(entity.get("state")) for entity in all_states if entity.get("entity_id") in wan_ids),
        None,
    )
    connectivity_summary["wanState"] = wan_state
    connectivity_summary["externalIp"] = next(
        (str(entity.get("state")) for entity in all_states if entity.get("entity_id") in ip_ids),
        None,
    )

    return {
        "hours": window,
        "points": points_out,
        "download": summarize(download_values),
        "upload": summarize(upload_values),
        "devices": {
            **summarize([float(value) for value in device_values]),
            "now": sum(1 for entity in all_states if str(entity.get("entity_id", "")).startswith("device_tracker.") and entity.get("state") == "home"),
            "tracked": len(tracker_ids),
        },
        "connectivity": connectivity_summary,
    }


# When Home Assistant restarts, every device_tracker re-reports at the same
# instant. That is not 40 devices joining the network -- it is one restart, and
# showing it as activity buries the real joins and leaves entirely.
RESTART_BURST_MIN = 8


def _drop_restart_bursts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for event in events:
        stamp = str(event["at"])[:19]
        counts[stamp] = counts.get(stamp, 0) + 1
    return [event for event in events if counts[str(event["at"])[:19]] < RESTART_BURST_MIN]


@app.get("/api/insights/clients", dependencies=[Depends(require_configuration)])
async def network_clients(
    hours: int = 24,
    client: HomeAssistantClient = Depends(get_client),
) -> dict[str, Any]:
    """What is on the network now, and what joined or left recently.

    The router publishes one `device_tracker` per client carrying its IP, MAC
    and hostname, so the current list comes straight from entity state. The
    join/leave timeline needs history, which is a second (larger) request --
    hence a separate endpoint from /insights/network rather than making that
    one slower for callers that only want speeds.
    """
    window = max(1, min(hours, 168))
    try:
        all_states = await client.states()
    except httpx.HTTPError as error:
        raise upstream_error(error) from error

    trackers = [
        entity for entity in all_states
        if str(entity.get("entity_id", "")).startswith("device_tracker.")
    ]

    def describe(entity: dict[str, Any]) -> dict[str, Any]:
        attributes = entity.get("attributes") or {}
        return {
            "entityId": entity.get("entity_id"),
            "name": attributes.get("friendly_name") or entity.get("entity_id"),
            "ip": attributes.get("ip"),
            "mac": attributes.get("mac"),
            "hostname": attributes.get("host_name"),
            "home": entity.get("state") == "home",
            "since": entity.get("last_changed"),
        }

    described = [describe(entity) for entity in trackers]
    # Most recently changed first: a device that just joined is the one someone
    # is most likely looking for.
    described.sort(key=lambda item: str(item["since"] or ""), reverse=True)

    events: list[dict[str, Any]] = []
    tracker_ids = [str(entity["entity_id"]) for entity in trackers]
    if tracker_ids:
        try:
            series = await client.history_many(tracker_ids, window)
        except httpx.HTTPError as error:
            raise upstream_error(error) from error
        names = {item["entityId"]: item["name"] for item in described}
        for rows in series:
            if not rows:
                continue
            entity_id = str(rows[0].get("entity_id", ""))
            previous: str | None = None
            for row in rows:
                parsed = connectivity.parse_point(row)
                if not parsed:
                    continue
                moment, state = parsed
                # Only transitions are interesting; the first row just carries
                # whatever state the device already held when the window opened.
                if previous is not None and state != previous and state in ("home", "not_home"):
                    events.append({
                        "at": datetime.fromtimestamp(moment, timezone.utc).isoformat().replace("+00:00", "Z"),
                        "name": names.get(entity_id, entity_id),
                        "joined": state == "home",
                    })
                previous = state
        events.sort(key=lambda item: str(item["at"]), reverse=True)
        events = _drop_restart_bursts(events)

    firmware = next(
        (entity for entity in all_states if entity.get("entity_id") == "update.cbr750_firmware"),
        None,
    )
    firmware_attributes = (firmware or {}).get("attributes") or {}

    return {
        "hours": window,
        "onlineCount": sum(1 for item in described if item["home"]),
        "trackedCount": len(described),
        "clients": [item for item in described if item["home"]],
        "events": events[:40],
        "router": {
            "firmwareInstalled": firmware_attributes.get("installed_version"),
            "firmwareLatest": firmware_attributes.get("latest_version"),
            "updateAvailable": (firmware or {}).get("state") == "on",
        },
    }


@app.get("/api/history/{entity_id}", dependencies=[Depends(require_configuration)])
async def history(
    entity_id: str,
    hours: int = 24,
    client: HomeAssistantClient = Depends(get_client),
) -> list[list[dict[str, Any]]]:
    try:
        return await client.history(entity_id, max(1, min(hours, 24 * 31)))
    except httpx.HTTPError as error:
        raise upstream_error(error) from error


@app.websocket("/api/ws")
async def events(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = bridge.subscribe()
    try:
        await websocket.send_json({"type": "ready", "configured": settings.configured})
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        bridge.unsubscribe(queue)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
