#!/usr/bin/env python3
"""Regenerates app/airports_worldwide.json from OurAirports' public-domain airport list.

Run this by hand when the bundled dataset needs refreshing (new airports, renamed cities) --
nothing at runtime fetches this. Source: https://github.com/davidmegginson/ourairports-data
(mirrors ourairports.com/data, released to the public domain).

    python3 backend/scripts/build_airports_data.py
"""

from __future__ import annotations

import csv
import io
import json
import urllib.request
from pathlib import Path

SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "app" / "airports_worldwide.json"

# Every large/medium airport, plus anything smaller that still carries a real IATA code (the
# schedule feeds only ever hand back IATA codes, so a small field without one is never looked up
# by that path anyway). This keeps the bundle to commercial-scale airports rather than every
# grass strip and heliport OurAirports also carries.
KEEP_TYPES = {"large_airport", "medium_airport"}


def build() -> dict[str, list]:
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
        text = response.read().decode("utf-8")

    rows: dict[str, list] = {}
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        if row.get("type") == "closed":
            continue
        icao = (row.get("icao_code") or row.get("gps_code") or "").strip().upper()
        iata = (row.get("iata_code") or "").strip().upper()
        # resolve_airport() keys on ICAO -- OpenSky flight history and adsbdb both hand back
        # ICAO, so anything without a clean 4-letter code here is unreachable regardless.
        if len(icao) != 4 or not icao.isalpha():
            continue
        if row.get("type") not in KEEP_TYPES and not iata:
            continue
        try:
            lat = round(float(row["latitude_deg"]), 4)
            lon = round(float(row["longitude_deg"]), 4)
        except (TypeError, ValueError):
            continue
        city = (row.get("municipality") or "").strip() or None
        name = (row.get("name") or "").strip() or None
        country = (row.get("iso_country") or "").strip() or None
        rows[icao] = [iata or None, city or name, country, lat, lon]

    return rows


def main() -> None:
    rows = build()
    OUTPUT_PATH.write_text(json.dumps(rows, separators=(",", ":"), sort_keys=True))
    print(f"wrote {len(rows)} airports to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
