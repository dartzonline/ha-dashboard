"""Supervisor's options.json -> environment variables, including the values that are falsy but real."""

from __future__ import annotations

import json

import addon_entrypoint


def _apply(tmp_path, monkeypatch, options):
    path = tmp_path / "options.json"
    path.write_text(json.dumps(options))
    monkeypatch.setattr(addon_entrypoint, "OPTIONS_PATH", path)
    for env_key in addon_entrypoint.OPTION_ENV_MAP.values():
        monkeypatch.delenv(env_key, raising=False)
    addon_entrypoint.apply_addon_options()


def test_zero_and_false_are_real_values_not_unset(tmp_path, monkeypatch):
    """`airlabs_daily_budget: 0` is how a metered source gets switched off; it used to be dropped."""
    import os

    _apply(tmp_path, monkeypatch, {"airlabs_daily_budget": 0, "energy_rate_per_kwh": 0.0, "airlabs_key": False})
    assert os.environ["AIRLABS_DAILY_BUDGET"] == "0"
    assert os.environ["ENERGY_RATE_PER_KWH"] == "0.0"
    assert os.environ["AIRLABS_KEY"] == "False"


def test_none_and_empty_string_are_left_unset(tmp_path, monkeypatch):
    import os

    _apply(tmp_path, monkeypatch, {"opensky_client_id": "", "opensky_client_secret": None, "airlabs_key": "k"})
    assert "OPENSKY_CLIENT_ID" not in os.environ
    assert "OPENSKY_CLIENT_SECRET" not in os.environ
    assert os.environ["AIRLABS_KEY"] == "k"


def test_a_missing_options_file_is_survived(tmp_path, monkeypatch):
    monkeypatch.setattr(addon_entrypoint, "OPTIONS_PATH", tmp_path / "absent.json")
    addon_entrypoint.apply_addon_options()
