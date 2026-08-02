# Home Panel

A React and FastAPI dashboard for Home Assistant. Home Assistant remains the device, automation, and recorder engine; this project provides a fast, information-rich wall-dashboard interface with live controls, alerts, world clocks, visual analytics, a confirmed Night Mode routine, a nearby/on-demand flight tracker, energy usage, and sundown auto-dim for kiosk use. The interface is tuned for wall tablets such as Amazon Fire tablets: navigation stays hidden until you need it, text scales up for arm's-length reading, and every control is touch-first (swipe between sections, no hover-only affordances).

See [`CHANGELOG.md`](CHANGELOG.md) for release notes — Home Assistant's Supervisor also surfaces it as the add-on's "What's new" text on every version bump.

## Quick run modes

### Run on Home Assistant OS (local add-on)

1. Copy this repository to your Home Assistant add-ons directory so the folder becomes `/addons/home-command-center`.
2. In Home Assistant, open **Settings -> Add-ons -> Add-on store**, then run **Check for updates**.
3. Install **Home Panel** (local add-on), then start it.
4. Enable **Start on boot** and **Show in sidebar**.
5. Open **Home Panel** from the Home Assistant sidebar.

Notes:

- You do not need to set `HA_URL` or `HA_TOKEN` for add-on mode.
- The add-on uses Supervisor auth via `SUPERVISOR_TOKEN`.

### Run on a separate server (outside Home Assistant OS)

Choose either Docker Compose or native runtime.

Docker Compose:

1. Create env file: `cp backend/.env.example backend/.env`
2. Set `HA_URL` and `HA_TOKEN` in `backend/.env`
3. Start: `docker compose up --build -d`
4. Open `http://localhost:8000`

Native runtime:

1. Install frontend deps: `npm --prefix frontend install`
2. Create venv: `python3 -m venv backend/.venv`
3. Install backend deps: `backend/.venv/bin/pip install -r backend/requirements.txt`
4. Create env file: `cp backend/.env.example backend/.env`
5. Set `HA_URL` and `HA_TOKEN` in `backend/.env`
6. Start: `./run.sh`

## One-command start with Docker

Docker builds the React frontend and packages it with the FastAPI bridge. The Home Assistant token is injected only when the container starts.

1. Create the runtime environment once:

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Set `HA_URL` and `HA_TOKEN` in `backend/.env`. For Docker, prefer a stable Home Assistant LAN IP or normal DNS name because `homeassistant.local` multicast DNS may not resolve inside a container.

3. Build and start everything:

   ```bash
   docker compose up --build -d
   ```

4. Open [http://localhost:8000](http://localhost:8000).

Useful commands:

```bash
# Follow application logs
docker compose logs -f dashboard

# Rebuild after code changes
docker compose up --build -d

# Stop the dashboard
docker compose down

# Publish on another host port
PORT=8080 docker compose up --build -d
```

The container healthcheck verifies that FastAPI responds. A Home Assistant outage leaves the dashboard process running and is reported as a degraded connection in the UI.

## Install as a Home Assistant add-on

This route requires Home Assistant OS or Home Assistant Supervised, because Home Assistant Container/Core installations do not include the Supervisor add-on store.

1. Copy this entire repository into the Home Assistant `/addons` share so the resulting path is `/addons/home-command-center`. You can use the Samba share, Studio Code Server, or an SSH terminal. Keep `Dockerfile`, `config.yaml`, `frontend/`, and `backend/` together in that folder.
2. In Home Assistant, open **Settings → Add-ons → Add-on store**, open the overflow menu, and select **Check for updates**.
3. Select the **Home Panel** local add-on and choose **Install**. The first local build can take several minutes.
4. Start the add-on and enable **Start on boot** and **Show in sidebar**.
5. Open **Home Panel** from the sidebar. No long-lived token is required: `homeassistant_api: true` supplies a scoped `SUPERVISOR_TOKEN`, and the backend automatically uses `http://supervisor/core`.

The frontend builds with relative assets and resolves HTTP/WebSocket API calls from `document.baseURI`, so Home Assistant's changing ingress prefix is preserved. Port `8000` is mapped by default so the dashboard is also reachable directly on your LAN at `http://<home-assistant-ip>:8000` — handy for a wall tablet that shouldn't have to go through Home Assistant's own login. Because that port doubles as the ingress port, it won't appear as an editable field under the add-on's **Network** tab (Supervisor hides ingress ports from manual remapping there); the default mapping in `config.yaml` is what makes it reachable without any UI step. Don't forward port `8000` on your router — keep it LAN/VPN-only, same as the Compose deployment. Add-on configuration follows the [Home Assistant app/add-on configuration documentation](https://developers.home-assistant.io/docs/add-ons/configuration/). Content was rephrased for compliance with licensing restrictions.

After changing source files in `/addons/home-command-center`, return to the add-on page and use **Rebuild** (or uninstall/install if your Supervisor version does not show Rebuild), then start it again.

## Secure external access

Use the same authenticated Home Assistant URL you already trust:

- With Home Assistant Cloud/Nabu Casa, open your Home Assistant remote URL, sign in, and select **Home Panel** in the sidebar.
- With your own Home Assistant HTTPS domain or VPN, sign in through that URL and open the sidebar item in the same way.
- Ingress remains under Home Assistant authentication; the browser does not receive the Supervisor token or a Home Assistant long-lived token.

Do **not** expose this application's port `8000` directly to the public internet. The backend can call Home Assistant services and does not provide separate app-level authentication. If you run the Compose version remotely, keep it on a private LAN/VPN or place it behind an authenticated reverse proxy. Do not forward port `8000` from your router.

## Wall tablet layout

- The navigation panel is hidden on load. Tap the menu button next to the page title to slide it in; picking a section, tapping the backdrop, or pressing Escape closes it again.
- Base text scales fluidly with the panel above 700px wide (`clamp(19px, 1.15vw + .9vh, 26px)`) rather than through capped breakpoints. A Fire HD 10 in landscape reports about 1443 CSS px, which fell outside every `max-width: 1440px` rule and left the panel at phone-sized text; the fluid ramp cannot be missed that way. That ramp has since been raised: every panel sizes in rem, so a larger root value scales the whole dashboard together, and a Fire HD 10 now lands near a 24px base — legible from across the room rather than only at arm's length.
- Device pages fill the viewport height: the tile grid stretches its rows into the space that is left instead of ending in a dead band, and each tile leads with its reading in large type with the label above it in small caps. Household presence sits on the section heading line rather than owning a band of its own.
- The top banner carries six live cells including connected-device counts derived from router `device_tracker` entities. When a device joins within the last 30 minutes, its name appears there and alternates through up to three recent arrivals.
- Tapping the security cell or the alert strip names the exact open doors, windows, covers, unlocked locks, leaks, and faulting devices, with how long each has been that way. Each row opens that entity's full detail sheet.

## Thermostat dial

The thermostat tile is a circular dial. Drag around the arc or use the minus/plus buttons to set the target; arrow keys work when it is focused, and it exposes `role="slider"` with proper value bounds. The arc is colour-coded by what the system is actually doing: blue while cooling, orange while heating, neutral when idle or off. The centre shows the target, the current room temperature, and humidity.

Tapping the tile (anywhere outside the dial) opens the full sheet with a larger dial plus HVAC modes, fan modes, presets, and history. Some thermostats, including ecobee, report a Celsius-style `min_temp`, so the dial clamps its range to a usable 50-90°F band rather than honouring a 4.4 minimum.

## Night Mode

The prominent **Moments → Night Mode** button always shows a browser confirmation before sending the action. The backend also rejects calls that do not include `{"confirm": true}`.

Once confirmed, one backend request:

- Locks every non-`unavailable`/non-`unknown` `lock.*` entity that is not already locked.
- Closes an open/opening garage cover, including `cover.ratgdov25i_8e54c8_door`.
- Turns off the approved indoor lights: pantry (`light.smart_wi_fi_switch_2`), both media-room lights, My Rest light/clock, and the chandelier.
- Turns off an active `switch.*` only when its entity/friendly name clearly identifies it as a light/lamp and it does not match a protected term.
- Reports partial failures in the button instead of claiming the routine succeeded.

The conservative protection filter excludes outdoor/porch/patio/driveway/garage lighting switches, child/toddler locks, appliances, washer/dryer/refrigerator power, vacuum/Roborock settings, alarm/safety controls, firmware controls, and Dyson configuration switches. `light.zooz_double_switch_relay` is not included because its location is unknown. To classify another indoor light, add its exact entity ID to `NIGHT_MODE_INDOOR_LIGHTS` in `backend/app/main.py`.

Night Mode controls physical security devices. Review the allowlist after entity renames, and validate only its confirmation/error path unless you intentionally want to operate the real devices.

## Dashboard analytics

Insights is built for a wall display: it fills the viewport height and never needs scrolling. The four key metric cards stay pinned, and the panels below rotate through three slides every 20 seconds, so Insights holds for a full minute before the dashboard advances to the next section.

1. **Climate and comfort** — inside/outside/air-quality/access readings, the seven-room 24-hour temperature overlay, and current room telemetry.
2. **Connectivity and energy** — gateway upload/download throughput, monthly energy comparison, and 30-day water-softener salt history.
3. **Home health** — lowest-battery ranking, plant-moisture gauges, and appliance/vacuum/maintenance status.

Temperature history is drawn as gradient-filled areas everywhere it appears: the room overlay, entity history sheets, and every expanded detail panel.

Rotation rules across the whole dashboard:

- Each section, and each Insights slide, holds for 20 seconds.
- Any interaction (tap, click, or drag) pauses rotation so the current page stays on screen while you use it.
- The clock-area rotation button resumes rotation and shows the current Insights slide, for example `20s · 2/3`.
- Selecting the slide indicators jumps straight to a panel group and pauses rotation.

Recorder requests remain bounded to 24 hours, 7 days, or 30 days depending on the chart.

## Dashboard configuration editor

Tap **Configure** at the bottom of the sidebar to open a live editor instead of hand-editing source:

- **Dashboard tiles** — add, remove, reorder, relabel, and re-icon tiles per section, with entity-ID autocomplete drawn from your live Home Assistant entities.
- **Night Mode lights** — a checklist of your real `light.*` entities controls which lights Night Mode is allowed to switch off, replacing the old hardcoded allowlist in source.

Changes are saved through the backend (`GET`/`PUT`/`DELETE /api/config`) to `/data/dashboard-config.json` in the Home Assistant add-on (Supervisor's persistent storage) or `backend/data/` for native/Compose runs — a named Docker volume keeps that directory across container rebuilds. **Reset to defaults** clears the override and reverts to the bundled configuration. The physical-security protection filter behind Night Mode (which switches are never touched, regardless of name) stays in source, not the editor, on purpose.

## Every tile tells a story

- Numeric sensor tiles carry an inline 24-hour sparkline; the doors-open tile instead names which door or window is open (a sparkline of a door count isn't useful).
- Discrete entities (lights, locks, covers, media players, vacuums, fans, climate) show a 24-hour on/off activity strip in their detail sheet, with per-state totals.
- The Home page's Internet tile expands into a 24-hour view: average download and upload speed in Mbps by hour, alongside the average number of devices connected. Home Assistant has no clients-online sensor, so `GET /api/insights/network?hours=24` reconstructs that count by replaying every `device_tracker` entity's state history.
- An activity log (the clock icon next to the time) keeps a running, timestamped history of every state change the dashboard has seen this session.

## Presence, media, and moments

- **Presence** — `person.*` entities appear as chips on the Home page's section-heading line (home/away, with a relative "since" time).
- **Now playing** — a persistent bar appears at the bottom of the screen whenever a `media_player.*` is playing, with artwork, title, and transport controls. Artwork is proxied through `GET /api/entity-picture/{entity_id}` since Home Assistant's `entity_picture` path needs the backend's auth token, which the browser never receives.
- **Night Mode** and the thermostat quick-access button remain the two one-tap **Moments**.

## World time

The section (**World time** in the navigation) is a touch map, not a static set of clocks. Every point on it is a control:

- **Touch anywhere on the map** to drop a pin. The tapped position converts to latitude/longitude (the basemap is a plain equirectangular projection) and resolves against a bundled table of ~110 cities in `frontend/src/worldCities.ts`, so the reading uses a real IANA zone and gets DST right. The pin joins the clock rail as its own card until you clear it — a **Clear pin** control on the map removes it, and a selection releases back to home on its own after a few seconds so the wall panel never sits on a stale tap.
- **Taps more than 1500 km from any city** — mid-ocean, or deep polar — report an estimated zone derived from longitude (`UTC±N`, via `Etc/GMT±N`) and name the nearest city and its distance, rather than pretending to a precision the lookup does not have.
- **The four preset markers** (home, Frankfurt, Khammam in Telangana, India, and Auckland) and the clock cards select the same reading, so the map, the readout, and the rail always agree.
- **Tap a clock card** to open that city's weather: current conditions plus a short hourly and daily forecast, so a glance at a time zone also answers what it is like there.
- Each reading shows local time, the local date, day/night phase, the zone abbreviation, and how far ahead of or behind home it is.

Marker positions are computed from each location's coordinates rather than hand-placed percentages, so a marker cannot drift from the place it names.

## Energy usage

The Energy section (sidebar) discovers every `device_class: energy` sensor. Devices that report `_energy_yesterday` / `_energy_this_month` / `_energy_last_month` siblings (common with smart plugs and appliance monitors) render directly as stat cards; a bare cumulative counter falls back to deriving daily usage from 30 days of recorder history. A whole-home utility-meter sensor (matched by name — "smarthub", "utility", "grid", etc.) is broken out separately from per-device totals. Empty gracefully when no energy sensors exist yet.

Two panels sit alongside that breakdown:

- **Estimated bill so far** — this month's usage priced at your rate, with a projected month total.
- **Daily usage · last 14 days** — a chart of daily totals beside the per-device breakdown.

The price is one number, `energy_rate_per_kwh` (default `0.15`). Set it in the add-on's **Configuration** tab, or as `ENERGY_RATE_PER_KWH` in `backend/.env` for native/Compose runs. You can also edit the $/kWh rate inline on the Energy page itself; that saves through `PUT /api/config` and persists like the rest of the dashboard configuration.

## Weather

The hourly panel shows the next 12 hours from right now, rolling past midnight into tomorrow's forecast. It previously compared a local timestamp against a UTC date, so from late afternoon onward the panel emptied out exactly when the evening forecast mattered most.

The Weather section's fourth slide overlays an animated precipitation radar from [RainViewer](https://www.rainviewer.com/) (free, no API key) centered on your home coordinates, cycling through the last several frames with play/pause and an "as of" timestamp. The panel fills its whole rectangle: a dark [OpenStreetMap](https://www.openstreetmap.org/)/[CARTO](https://carto.com/) basemap sits under the precipitation layer, so the rain is drawn over recognizable geography rather than empty space.

## Flight tracker

The Flights section is a from-scratch port of [FlyInk-Board](https://github.com/dartzonline/FlyInk-Board-)'s aircraft-tracking data layer — OpenSky live positions, adsbdb route/aircraft enrichment, and optional AirLabs schedules — reimplemented as FastAPI endpoints (`backend/app/flights.py`) with no e-ink rendering, no Raspberry Pi, and no background polling loop.

- **Radar & Nearby** — a custom SVG radar scope over real dark map tiles ([CARTO](https://carto.com/) dark, free/keyless), plotting nearby aircraft by bearing and distance, colour-coded by climb/cruise/descend/ground. A live list below shows callsign, airline (with logo, sourced from [Jxck-S/airline-logos](https://github.com/Jxck-S/airline-logos)), aircraft type, route, altitude, speed, and distance. **Tap any aircraft to track it.**
- **Track a Flight** — type a flight number (IATA or ICAO) to pin it: a progress bar with live position, scheduled/actual times, a delay badge, and telemetry. The currently tracked flight also appears as a small badge in the header next to the clock.

**Route accuracy.** adsbdb's callsign lookup (`fromCode`/`toCode`) is a generic, undated historical mapping for that flight number — airlines reuse numeric designators across different city pairs on different days, so it's a guess, not a live fact. `backend/app/flights.py` resolves the actual origin/destination by priority: **live climb/descent-based inference** (is this plane actually climbing out of / descending into a known nearby airport right now?) → **real OpenSky flight history** for that aircraft (needs `OPENSKY_CLIENT_ID`/`SECRET` below) → the adsbdb guess, but only if the plane's current position and heading are geometrically plausible for that route at all. If none of that lines up, it shows no route rather than a wrong one. The live-motion airport list (`AIRPORTS` in `flights.py`) is seeded for the Austin/Central Texas region — extend it for your own area.

The flight-history lookup asks OpenSky for a 24-hour window. It used to ask for 36 hours, which OpenSky rejected every single time with `HTTP 400 — "You can only query across 2 partitions (days)"`, so that history tier never actually contributed a route.

**When the board is empty**, `GET /api/flights/status` says whether the sky is quiet or a key is missing: which upstreams are configured, whether the OpenSky token request and states query succeed, and the last error seen per upstream.

No API key is required for live positions and routes (OpenSky anonymous tier + adsbdb, both free). Three optional credentials improve it further — where you set them depends on how you're running the dashboard:

- **Home Assistant add-on:** the add-on's **Configuration** tab (Settings → Apps/Add-ons → Home Panel → Configuration) has fields for `opensky_client_id`, `opensky_client_secret`, and `airlabs_key`. Fill them in and restart the add-on — `backend/addon_entrypoint.py` reads Supervisor's `/data/options.json` and exports them as the environment variables below before the backend starts.
- **Native/Compose:** set the same values as env vars in `backend/.env`:

```bash
OPENSKY_CLIENT_ID=...      # free OpenSky account -> API client credentials; raises the anonymous rate limit
                           # AND unlocks that aircraft's real flight history, the most reliable
                           # route source available here (see "Route accuracy" below)
OPENSKY_CLIENT_SECRET=...
AIRLABS_KEY=...            # free tier from airlabs.co; adds scheduled times and delay status to tracked flights only
```

## Kiosk mode

The dashboard is meant to stay live and rotating through sections at all times on a wall-mounted display — there is no idle screensaver that covers it. **Auto-dim** is the one idle-driven behavior: the whole UI dims automatically after sunset, driven by Home Assistant's `sun.sun` entity.

## Native one-command start

If Node.js, Python dependencies, and `backend/.env` are already configured, this command rebuilds the current frontend and starts FastAPI:

```bash
./run.sh
```

Initial native setup:

```bash
npm --prefix frontend install
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

Then edit `backend/.env` and run `./run.sh`. The script always rebuilds the frontend so stale assets are not served.

## Development

Run FastAPI:

```bash
backend/.venv/bin/uvicorn app.main:app --app-dir backend --env-file backend/.env --reload
```

Run Vite in a second terminal:

```bash
npm --prefix frontend run dev
```

Vite proxies ingress-relative `api/` and WebSocket calls to FastAPI on port 8000.

Frontend checks:

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
```

## Architecture

- `frontend/`: React, TypeScript, Recharts, and responsive dashboard styling.
- `backend/`: FastAPI proxy for Home Assistant REST, recorder history, services, WebSocket events, and guarded aggregate actions.
- `Dockerfile`: multi-stage frontend build, non-root Python runtime, and Home Assistant add-on labels.
- `config.yaml`: local add-on metadata, authenticated ingress, sidebar panel, and Supervisor API permission.
- `compose.yaml`: runtime environment injection, port publishing, restart policy, and healthcheck.
- The browser never receives a Home Assistant or Supervisor token.
- FastAPI serves `frontend/dist`, so the production dashboard uses one origin and one server.

## Configuration and API

Edit `frontend/src/dashboardConfig.ts` to reorganize entity tiles. The bridge exposes:

- `GET /api/health`
- `GET /api/states` and `GET /api/states/{entity_id}`
- `POST /api/services/{domain}/{service}`
- `POST /api/actions/night-mode` with explicit `{"confirm": true}`
- `GET /api/history/{entity_id}?hours=24`
- `GET /api/entity-picture/{entity_id}` — proxies a `media_player`'s artwork with the backend's Home Assistant auth attached
- `GET`/`PUT`/`DELETE /api/config` — the dashboard tile layout, Night Mode light allowlist, and `energy_rate_per_kwh`, editable from the in-app **Configure** panel and the Energy page's inline rate field
- `GET /api/insights/network?hours=24` — hourly average download/upload speed in Mbps plus a connected-device count reconstructed from `device_tracker` history (see **Every tile tells a story** above)
- `GET /api/flights/nearby?latitude=&longitude=&limit=` and `GET`/`POST`/`DELETE /api/flights/track` — the flight tracker's data layer (see **Flight tracker** above)
- `GET /api/flights/status` — flight-tracker diagnostics: configured upstreams, OpenSky token/states health, and the last error per upstream
- `GET /api/weather/external?latitude=&longitude=&units=` — Open-Meteo forecast proxy. `units` is `imperial` (the default) or `metric`, and the response carries `units`, `temperatureUnit`, `windUnit`, and `precipitationUnit` alongside temperatures, wind, and precipitation in that system. It previously always answered in Celsius.
- `WS /api/ws` for live `state_changed` events

For native/Compose use, set `HA_URL` and `HA_TOKEN`. In the Home Assistant add-on, leave those unset so the automatic `SUPERVISOR_TOKEN` path is used. Keep Home Assistant running as the integration and automation engine; this project replaces its presentation layer, not its protocol adapters, integrations, recorder, or automations.

## Planned work

- [`docs/auto-entity-discovery.md`](docs/auto-entity-discovery.md) — design for having new Home Assistant entities automatically show up in the right dashboard section (with a chart, where relevant) instead of requiring a manual `dashboardConfig.ts`/Configure-panel edit. Not started.
