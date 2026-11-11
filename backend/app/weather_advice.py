"""Forecast advice: what the weather means for the house, said ahead of time.

A forecast says "gusts 70 km/h tomorrow afternoon". What a household wants to hear the evening
before is "Windy tomorrow afternoon -- tie down the patio furniture and bring the bins in". Each
rule here reads the hourly Open-Meteo forecast for one window (today, tonight, tomorrow, the days
after) and turns a threshold into a sentence with something to *do*.

Rules are deliberately few and conservative. A brief that warns about something every day gets
skimmed, and then the heavy-snow night goes unread too.

Everything is computed in metric and only formatted into the household's units at the end.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}

HEAVY_SNOW_CM = 5.0
SEVERE_SNOW_CM = 15.0
SOME_SNOW_CM = 1.0
HARD_FREEZE_C = -4.0
FREEZE_C = -1.0
FROST_C = 1.5
WINDY_GUST_KMH = 55.0
DAMAGING_GUST_KMH = 80.0
LEAF_DAY_GUST_KMH = 40.0
HEAVY_RAIN_MM = 20.0
RAIN_MM = 2.0
RAIN_CHANCE = 60
HOT_FEELS_C = 30.0
EXTREME_HEAT_FEELS_C = 35.0
MUGGY_DEW_POINT_C = 20.0
OPPRESSIVE_DEW_POINT_C = 24.0
DRY_HUMIDITY = 25.0
HIGH_UV = 8.0
COLDER_TOMORROW_C = 10.0
THUNDER_CODES = {95, 96, 99}
FOG_CODES = {45, 48}
FREEZING_RAIN_CODES = {56, 57, 66, 67}

FORECAST_TTL_S = 20 * 60
_forecast_cache: dict[tuple[float, float], tuple[float, dict[str, Any]]] = {}


async def fetch_forecast(client: httpx.AsyncClient, latitude: float, longitude: float) -> dict[str, Any]:
    """Metric hourly and daily forecast, yesterday through three days out. Cached for 20 minutes."""
    key = (round(latitude, 2), round(longitude, 2))
    cached = _forecast_cache.get(key)
    if cached and time.time() - cached[0] < FORECAST_TTL_S:
        return cached[1]
    query = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m", "dew_point_2m",
            "precipitation_probability", "precipitation", "snowfall", "weather_code",
            "wind_speed_10m", "wind_gusts_10m", "uv_index",
        ]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
            "sunrise", "sunset", "daylight_duration",
        ]),
        "timezone": "auto",
        "past_days": 1,
        "forecast_days": 4,
    }
    response = await client.get(f"https://api.open-meteo.com/v1/forecast?{urlencode(query)}", timeout=8)
    response.raise_for_status()
    payload = response.json()
    _forecast_cache[key] = (time.time(), payload)
    return payload


# --- reading the forecast ---------------------------------------------------


@dataclass
class Hour:
    at: datetime
    temp: float | None
    feels: float | None
    humidity: float | None
    dew_point: float | None
    rain_chance: float | None
    precipitation: float
    snowfall_cm: float
    code: int | None
    wind: float | None
    gust: float | None
    uv: float | None


def _num(values: list[Any], index: int) -> float | None:
    value = values[index] if index < len(values) else None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def hours(forecast: dict[str, Any]) -> list[Hour]:
    hourly = forecast.get("hourly") or {}
    rows: list[Hour] = []
    for index, stamp in enumerate(hourly.get("time") or []):
        try:
            at = datetime.fromisoformat(str(stamp))
        except ValueError:
            continue
        code = _num(hourly.get("weather_code") or [], index)
        rows.append(Hour(
            at=at,
            temp=_num(hourly.get("temperature_2m") or [], index),
            feels=_num(hourly.get("apparent_temperature") or [], index),
            humidity=_num(hourly.get("relative_humidity_2m") or [], index),
            dew_point=_num(hourly.get("dew_point_2m") or [], index),
            rain_chance=_num(hourly.get("precipitation_probability") or [], index),
            precipitation=_num(hourly.get("precipitation") or [], index) or 0.0,
            snowfall_cm=_num(hourly.get("snowfall") or [], index) or 0.0,
            code=int(code) if code is not None else None,
            wind=_num(hourly.get("wind_speed_10m") or [], index),
            gust=_num(hourly.get("wind_gusts_10m") or [], index),
            uv=_num(hourly.get("uv_index") or [], index),
        ))
    return rows


def local_now(forecast: dict[str, Any], now: float | None = None) -> datetime:
    """Wall-clock time at the forecast location, as a naive datetime like Open-Meteo's own."""
    offset = forecast.get("utc_offset_seconds")
    moment = now if now is not None else time.time()
    shifted = moment + (offset if isinstance(offset, (int, float)) else 0)
    return datetime.fromtimestamp(shifted, timezone.utc).replace(tzinfo=None)


@dataclass
class Window:
    key: str
    label: str
    hours: list[Hour] = field(default_factory=list)

    def _values(self, attr: str) -> list[float]:
        return [value for value in (getattr(hour, attr) for hour in self.hours) if value is not None]

    def max(self, attr: str) -> float | None:
        values = self._values(attr)
        return max(values) if values else None

    def min(self, attr: str) -> float | None:
        values = self._values(attr)
        return min(values) if values else None

    def total(self, attr: str) -> float:
        return sum(self._values(attr))

    @property
    def codes(self) -> set[int]:
        return {hour.code for hour in self.hours if hour.code is not None}

    def first_hour(self, test) -> datetime | None:
        return next((hour.at for hour in self.hours if test(hour)), None)


def windows(rows: list[Hour], now: datetime) -> list[Window]:
    """Today (what is left of the daytime), tonight, tomorrow, and the two days after by name."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    spans = [
        ("today", "today", max(now, today + timedelta(hours=6)), today + timedelta(hours=21)),
        ("tonight", "tonight", max(now, today + timedelta(hours=18)), today + timedelta(days=1, hours=8)),
        ("tomorrow", "tomorrow", today + timedelta(days=1, hours=6), today + timedelta(days=2)),
    ]
    for offset in (2, 3):
        start = today + timedelta(days=offset)
        spans.append((f"day{offset}", start.strftime("%A"), start, start + timedelta(days=1)))
    result = []
    for key, label, start, end in spans:
        window = Window(key, label, [hour for hour in rows if start <= hour.at < end])
        if window.hours:
            result.append(window)
    return result


# --- formatting ---------------------------------------------------------------


class Units:
    def __init__(self, imperial: bool) -> None:
        self.imperial = imperial

    def temp(self, celsius: float) -> str:
        return f"{celsius * 9 / 5 + 32:.0f}°F" if self.imperial else f"{celsius:.0f}°C"

    def temp_delta(self, celsius: float) -> str:
        return f"{celsius * 9 / 5:.0f}°F" if self.imperial else f"{celsius:.0f}°C"

    def wind(self, kmh: float) -> str:
        return f"{kmh / 1.609:.0f} mph" if self.imperial else f"{kmh:.0f} km/h"

    def snow(self, cm: float) -> str:
        if self.imperial:
            inches = cm / 2.54
            return f"{inches:.1f} in" if inches < 2 else f"{inches:.0f} in"
        return f"{cm:.0f} cm"

    def rain(self, mm: float) -> str:
        return f"{mm / 25.4:.1f} in" if self.imperial else f"{mm:.0f} mm"


def _clock(at: datetime) -> str:
    hour = at.hour % 12 or 12
    return f"{hour} {'am' if at.hour < 12 else 'pm'}"


def _part_of_day(at: datetime) -> str:
    if at.hour < 12:
        return "morning"
    if at.hour < 17:
        return "afternoon"
    return "evening"


# --- rules --------------------------------------------------------------------


@dataclass(frozen=True)
class Advice:
    id: str
    window: str
    when: str
    severity: str
    kind: str
    title: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id, "window": self.window, "when": self.when, "severity": self.severity,
            "kind": self.kind, "title": self.title, "detail": self.detail,
        }


def _window_advice(window: Window, units: Units, month: int) -> list[Advice]:
    found: list[Advice] = []
    when = window.label

    def add(rule: str, severity: str, kind: str, title: str, detail: str) -> None:
        found.append(Advice(f"{rule}:{window.key}", window.key, when, severity, kind, title, detail))

    snow = window.total("snowfall_cm")
    if snow >= HEAVY_SNOW_CM:
        add("snow", "critical" if snow >= SEVERE_SNOW_CM else "warning", "snow",
            f"Heavy snow {when}: {units.snow(snow)}",
            "Park the car in the garage or face it out, put the shovel and salt by the door, "
            "and charge phones in case the power drops.")
    elif snow >= SOME_SNOW_CM:
        add("snow", "info", "snow", f"Snow {when}: about {units.snow(snow)}",
            "Salt the steps and driveway before it settles; leave a few minutes early.")

    if window.codes & FREEZING_RAIN_CODES:
        add("ice", "warning", "ice", f"Freezing rain {when}",
            "Roads and steps will glaze over. Salt the walk, and give the car extra time to defrost.")

    low = window.min("temp")
    if low is not None and window.key not in ("today",):
        if low <= HARD_FREEZE_C:
            add("freeze", "warning", "freeze", f"Hard freeze {when}: down to {units.temp(low)}",
                "Disconnect garden hoses, cover tender plants, and open the cabinet doors under sinks "
                "on outside walls so the pipes stay warm.")
        elif low <= FREEZE_C:
            add("freeze", "info", "freeze", f"Freezing {when}: {units.temp(low)}",
                "Bring potted plants in, unhook the hoses, and plan a few minutes to scrape the car.")
        elif low <= FROST_C:
            add("frost", "info", "frost", f"Frost likely {when}",
                "Cover or bring in tender plants; the windshield may need scraping.")

    gust = window.max("gust")
    if gust is not None and gust >= WINDY_GUST_KMH:
        peak = max(window.hours, key=lambda hour: hour.gust or 0).at
        severe = gust >= DAMAGING_GUST_KMH
        add("wind", "critical" if severe else "warning", "wind",
            f"{'Damaging winds' if severe else 'Windy'} {when}: gusts to {units.wind(gust)}"
            + (f" around {_clock(peak)}" if window.key in ("today", "tomorrow", "tonight") else ""),
            "Secure the patio furniture, cushions, umbrella and trampoline, and bring the bins in."
            + (" Park away from trees and charge devices in case the power goes out." if severe else ""))
    elif gust is not None and gust >= LEAF_DAY_GUST_KMH and month in (10, 11):
        add("leaves", "info", "leaves", f"Windy leaf day {when}",
            "The gutters and downspouts will fill; a good day to wait on raking until the wind drops.")

    # Precipitation counts snow as its melted water; a centimetre of snow is roughly a millimetre.
    rain = max(0.0, window.total("precipitation") - snow)
    chance = window.max("rain_chance") or 0
    thunder = bool(window.codes & THUNDER_CODES)
    if thunder:
        add("storm", "warning", "storm", f"Thunderstorms {when}",
            "Bring in cushions and anything that can blow away, and unplug sensitive electronics.")
    if rain >= HEAVY_RAIN_MM:
        add("rain", "warning", "rain", f"Heavy rain {when}: {units.rain(rain)}",
            "Check the gutters and downspouts are clear, close the windows, and move cushions under cover.")
    elif rain >= RAIN_MM and chance >= RAIN_CHANCE and not thunder:
        start = window.first_hour(lambda hour: (hour.rain_chance or 0) >= RAIN_CHANCE and hour.precipitation > 0.1)
        add("rain", "info", "rain", f"Rain {when}" + (f" from {_clock(start)}" if start and window.key == "today" else ""),
            "Take an umbrella, close the car windows, and skip watering the garden.")

    feels = window.max("feels")
    if feels is not None and window.key != "tonight":
        if feels >= EXTREME_HEAT_FEELS_C:
            add("heat", "critical", "heat", f"Extreme heat {when}: feels like {units.temp(feels)}",
                "Pre-cool the house this morning, close blinds on the sunny side, keep pets inside "
                "with water, and check on anyone elderly.")
        elif feels >= HOT_FEELS_C:
            add("heat", "warning", "heat", f"Hot {when}: feels like {units.temp(feels)}",
                "Close the blinds before noon, water plants early, and keep a water bottle handy.")

    dew = window.max("dew_point")
    if dew is not None and dew >= MUGGY_DEW_POINT_C:
        oppressive = dew >= OPPRESSIVE_DEW_POINT_C
        add("humid", "warning" if oppressive else "info", "humid", f"{'Oppressively humid' if oppressive else 'Muggy'} {when}",
            "Run the dehumidifier or the AC's dry mode, keep windows shut, and skip line-drying laundry.")

    humidity_low = window.min("humidity")
    if humidity_low is not None and humidity_low <= DRY_HUMIDITY and window.key != "tonight":
        add("dry", "info", "dry", f"Very dry air {when}",
            "Run a humidifier, water houseplants, and expect static shocks.")

    uv = window.max("uv")
    if uv is not None and uv >= HIGH_UV and window.key in ("today", "tomorrow"):
        add("uv", "info", "uv", f"Very high UV {when}",
            "Sunscreen and a hat between 11 am and 3 pm.")

    if window.key == "today" and window.codes & FOG_CODES:
        foggy = window.first_hour(lambda hour: hour.code in FOG_CODES)
        if foggy is not None and foggy.hour < 12:
            add("fog", "info", "fog", "Fog this morning",
                "Headlights on and leave a few minutes early.")
    return found


def _thoughtful_advice(by_key: dict[str, Window], units: Units) -> list[Advice]:
    """The gentler notes: nice evenings, drying days, big temperature swings."""
    found: list[Advice] = []
    today, tonight, tomorrow = by_key.get("today"), by_key.get("tonight"), by_key.get("tomorrow")

    if today:
        evening = [hour for hour in today.hours if 18 <= hour.at.hour <= 21]
        if evening and all(
            hour.temp is not None and 15 <= hour.temp <= 25 and hour.precipitation < 0.1 and (hour.wind or 0) < 20
            for hour in evening
        ):
            found.append(Advice("nice-evening:today", "today", "this evening", "info", "evening",
                                "Lovely evening ahead",
                                "Mild, dry and calm after 6 pm: a good night to eat outside or open the windows."))

        daytime = [hour for hour in today.hours if 9 <= hour.at.hour <= 16]
        if len(daytime) >= 4 and all(
            hour.precipitation < 0.1 and (hour.humidity or 100) < 60 and (hour.temp or 0) >= 15 for hour in daytime
        ) and any(10 <= (hour.wind or 0) <= 30 for hour in daytime):
            found.append(Advice("laundry:today", "today", "today", "info", "laundry", "Good drying day",
                                "Dry, breezy and warm: hang the laundry out this morning."))

    if today and tonight:
        high = today.max("temp")
        night_low = tonight.min("temp")
        if high is not None and night_low is not None and high >= 27 and night_low <= 18:
            found.append(Advice("cool-night:tonight", "tonight", "tonight", "info", "evening",
                                "Cool the house for free tonight",
                                f"It drops to {units.temp(night_low)} overnight: open the windows after sunset "
                                "and close them in the morning to hold the cool."))

    if today and tomorrow:
        high_today, high_tomorrow = today.max("temp"), tomorrow.max("temp")
        if high_today is not None and high_tomorrow is not None:
            drop = high_today - high_tomorrow
            if drop >= COLDER_TOMORROW_C:
                found.append(Advice("colder:tomorrow", "tomorrow", "tomorrow", "info", "cold",
                                    f"Much colder tomorrow: {units.temp_delta(drop)} cooler",
                                    f"A high of only {units.temp(high_tomorrow)}. Get the coats and gloves out tonight."))
            elif -drop >= COLDER_TOMORROW_C:
                found.append(Advice("warmer:tomorrow", "tomorrow", "tomorrow", "info", "warm",
                                    f"Much warmer tomorrow: {units.temp_delta(-drop)} warmer",
                                    f"Up to {units.temp(high_tomorrow)}. Dress in layers."))
    return found


def build_advice(forecast: dict[str, Any], imperial: bool, now: float | None = None) -> list[Advice]:
    """Every piece of advice for today through three days out, most urgent and soonest first."""
    local = local_now(forecast, now)
    units = Units(imperial)
    rows = hours(forecast)
    spans = windows(rows, local)
    advice: list[Advice] = []
    seen_today: set[str] = set()
    for window in spans:
        for item in _window_advice(window, units, local.month):
            rule = item.id.split(":", 1)[0]
            # The same weather spanning the afternoon and the night is one heads-up, not two.
            if window.key == "tonight" and rule in seen_today:
                continue
            # Further out, only what is worth preparing for.
            if window.key.startswith("day") and item.severity == "info":
                continue
            if window.key == "today":
                seen_today.add(rule)
            advice.append(item)
    advice += _thoughtful_advice({window.key: window for window in spans}, units)
    order = {"today": 0, "tonight": 1, "tomorrow": 2, "day2": 3, "day3": 4}
    advice.sort(key=lambda item: (order.get(item.window, 9), SEVERITY_RANK[item.severity]))
    return advice


def today_summary(forecast: dict[str, Any], imperial: bool, now: float | None = None) -> dict[str, Any] | None:
    """Today's high and low, sky, rain chance, sunrise and sunset, and how the daylight is changing."""
    daily = forecast.get("daily") or {}
    dates = daily.get("time") or []
    today = local_now(forecast, now).date().isoformat()
    if today not in dates:
        return None
    index = dates.index(today)
    units = Units(imperial)
    high = _num(daily.get("temperature_2m_max") or [], index)
    low = _num(daily.get("temperature_2m_min") or [], index)
    daylight = _num(daily.get("daylight_duration") or [], index)
    yesterday_daylight = _num(daily.get("daylight_duration") or [], index - 1) if index > 0 else None
    code = _num(daily.get("weather_code") or [], index)
    change = None
    if daylight is not None and yesterday_daylight is not None:
        minutes = round((daylight - yesterday_daylight) / 60)
        if minutes:
            change = f"{abs(minutes)} min {'more' if minutes > 0 else 'less'} daylight than yesterday"
        else:
            change = "About the same daylight as yesterday"

    def clock(value: Any) -> str | None:
        try:
            return _clock(datetime.fromisoformat(str(value))).replace(" ", "") if value else None
        except ValueError:
            return None

    def precise(value: Any) -> str | None:
        try:
            at = datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None
        return f"{at.hour % 12 or 12}:{at.minute:02d} {'am' if at.hour < 12 else 'pm'}"

    sunrise = (daily.get("sunrise") or [None] * (index + 1))[index]
    sunset = (daily.get("sunset") or [None] * (index + 1))[index]
    return {
        "date": today,
        "high": units.temp(high) if high is not None else None,
        "low": units.temp(low) if low is not None else None,
        "weatherCode": int(code) if code is not None else None,
        "rainChance": _num(daily.get("precipitation_probability_max") or [], index),
        "sunrise": precise(sunrise) or clock(sunrise),
        "sunset": precise(sunset) or clock(sunset),
        "daylightChange": change,
    }


def week_ahead(forecast: dict[str, Any], imperial: bool, now: float | None = None) -> list[dict[str, Any]]:
    """Tomorrow and the next two days: name, high, low, sky."""
    daily = forecast.get("daily") or {}
    dates = daily.get("time") or []
    today = local_now(forecast, now).date()
    units = Units(imperial)
    days = []
    for index, value in enumerate(dates):
        try:
            day = datetime.fromisoformat(str(value)).date()
        except ValueError:
            continue
        if day <= today:
            continue
        high = _num(daily.get("temperature_2m_max") or [], index)
        low = _num(daily.get("temperature_2m_min") or [], index)
        code = _num(daily.get("weather_code") or [], index)
        days.append({
            "date": value,
            "label": "Tomorrow" if day == today + timedelta(days=1) else day.strftime("%A"),
            "high": units.temp(high) if high is not None else None,
            "low": units.temp(low) if low is not None else None,
            "weatherCode": int(code) if code is not None else None,
            "rainChance": _num(daily.get("precipitation_probability_max") or [], index),
        })
    return days[:3]
