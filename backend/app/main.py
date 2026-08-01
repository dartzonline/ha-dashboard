import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import load_settings
from .event_bridge import EventBridge
from .ha_client import HomeAssistantClient

settings = load_settings()
bridge = EventBridge(settings)
ha_client = HomeAssistantClient(settings)

NIGHT_MODE_INDOOR_LIGHTS = {
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


app = FastAPI(title="Home Panel", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/api/weather/external")
async def external_weather(latitude: float, longitude: float) -> dict[str, Any]:
    query = {
        "latitude": latitude,
        "longitude": longitude,
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
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(url)
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
    lights = [
        str(entity["entity_id"])
        for entity in all_states
        if entity.get("entity_id") in NIGHT_MODE_INDOOR_LIGHTS and entity.get("state") == "on"
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
