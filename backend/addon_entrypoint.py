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
}


def apply_addon_options() -> None:
    if not OPTIONS_PATH.is_file():
        return  # not running as a Supervisor add-on (native/Compose) -- nothing to do
    try:
        options = json.loads(OPTIONS_PATH.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(options, dict):
        return
    for option_key, env_key in OPTION_ENV_MAP.items():
        value = options.get(option_key)
        if value:
            os.environ[env_key] = str(value)


if __name__ == "__main__":
    apply_addon_options()
    os.execvp(
        "uvicorn",
        ["uvicorn", "app.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8000"],
    )
