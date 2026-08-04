"""Add-on entrypoint: bridges Supervisor's options.json into environment variables.

Home Assistant add-ons don't use a .env file -- configuration entered in the add-on's
Configuration tab is written by Supervisor to /data/options.json inside the container,
keyed by the option names declared in config.yaml. This script reads that file (if present;
it isn't in native/Compose runs) and exports the matching env vars before handing off to
uvicorn, so backend/app/config.py's plain os.getenv() calls keep working unchanged.
"""

import json
import os
from pathlib import Path

OPTIONS_PATH = Path("/data/options.json")

# config.yaml option name -> environment variable name
OPTION_ENV_MAP = {
    "opensky_client_id": "OPENSKY_CLIENT_ID",
    "opensky_client_secret": "OPENSKY_CLIENT_SECRET",
    "airlabs_key": "AIRLABS_KEY",
    "airlabs_daily_budget": "AIRLABS_DAILY_BUDGET",
    "energy_rate_per_kwh": "ENERGY_RATE_PER_KWH",
}


def apply_addon_options() -> None:
    # Printed (not logged) because this runs before uvicorn/logging exist -- stdout is what
    # Supervisor's Log tab shows for this add-on either way. PYTHONUNBUFFERED=1 (Dockerfile)
    # means these show up immediately rather than sitting in a buffer.
    if not OPTIONS_PATH.is_file():
        print(f"[addon_entrypoint] {OPTIONS_PATH} not found -- not running under Supervisor, or /data isn't mounted; env vars must come from elsewhere.", flush=True)
        return
    try:
        raw = OPTIONS_PATH.read_text()
        options = json.loads(raw)
    except (OSError, ValueError) as error:
        print(f"[addon_entrypoint] failed to read/parse {OPTIONS_PATH}: {error}", flush=True)
        return
    if not isinstance(options, dict):
        print(f"[addon_entrypoint] {OPTIONS_PATH} did not contain a JSON object (got {type(options).__name__})", flush=True)
        return

    applied: list[str] = []
    present_but_empty: list[str] = []
    for option_key, env_key in OPTION_ENV_MAP.items():
        value = options.get(option_key)
        if value:
            os.environ[env_key] = str(value)
            applied.append(env_key)
        elif option_key in options:
            present_but_empty.append(option_key)

    print(f"[addon_entrypoint] {OPTIONS_PATH} keys: {sorted(options.keys())}", flush=True)
    print(f"[addon_entrypoint] env vars applied: {applied or 'none'}", flush=True)
    if present_but_empty:
        print(f"[addon_entrypoint] option present but empty/falsy in options.json: {present_but_empty} -- check the Configuration tab was actually saved", flush=True)


if __name__ == "__main__":
    apply_addon_options()
    os.execvp(
        "uvicorn",
        ["uvicorn", "app.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8000"],
    )
