# Home Panel

A React and FastAPI dashboard for Home Assistant. Home Assistant remains the device, automation, and recorder engine; this project provides a fast, information-rich wall-dashboard interface with live controls, alerts, world clocks, visual analytics, and a confirmed Night Mode routine. The interface is tuned for wall tablets such as Amazon Fire tablets: navigation stays hidden until you need it, and text scales up for arm's-length reading.

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

The frontend builds with relative assets and resolves HTTP/WebSocket API calls from `document.baseURI`, so Home Assistant's changing ingress prefix is preserved. Port `8000` is disabled in the add-on by default; authenticated ingress is the intended access path. Add-on configuration follows the [Home Assistant app/add-on configuration documentation](https://developers.home-assistant.io/docs/add-ons/configuration/). Content was rephrased for compliance with licensing restrictions.

After changing source files in `/addons/home-command-center`, return to the add-on page and use **Rebuild** (or uninstall/install if your Supervisor version does not show Rebuild), then start it again.

## Secure external access

Use the same authenticated Home Assistant URL you already trust:

- With Home Assistant Cloud/Nabu Casa, open your Home Assistant remote URL, sign in, and select **Home Panel** in the sidebar.
- With your own Home Assistant HTTPS domain or VPN, sign in through that URL and open the sidebar item in the same way.
- Ingress remains under Home Assistant authentication; the browser does not receive the Supervisor token or a Home Assistant long-lived token.

Do **not** expose this application's port `8000` directly to the public internet. The backend can call Home Assistant services and does not provide separate app-level authentication. If you run the Compose version remotely, keep it on a private LAN/VPN or place it behind an authenticated reverse proxy. Do not forward port `8000` from your router.

## Wall tablet layout

- The navigation panel is hidden on load. Tap the menu button next to the page title to slide it in; picking a section, tapping the backdrop, or pressing Escape closes it again.
- Base text scales up between 700px and 1440px wide, with a further bump for the ~1280x800 landscape range that Fire tablets report, so values stay readable at arm's length.
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
- `WS /api/ws` for live `state_changed` events

For native/Compose use, set `HA_URL` and `HA_TOKEN`. In the Home Assistant add-on, leave those unset so the automatic `SUPERVISOR_TOKEN` path is used. Keep Home Assistant running as the integration and automation engine; this project replaces its presentation layer, not its protocol adapters, integrations, recorder, or automations.
