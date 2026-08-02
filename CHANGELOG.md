# Changelog

Home Assistant's Supervisor shows this file's newest entries as the add-on's "What's new" release
notes, so every version bump in `config.yaml` gets a matching entry here.

## 1.0.1 - 2026-08-02

Diagnostic-only release for the Flights section reporting `opensky.configured: false` even with
`opensky_client_id`/`opensky_client_secret` visibly filled in on the Configuration tab and saved.
`backend/addon_entrypoint.py` now prints, on every startup (visible in the add-on's **Log** tab):
which keys `/data/options.json` actually contains, which env vars it derived and applied, and
which configured options came through empty/falsy despite being present. This doesn't fix
anything by itself — it's what's needed to see *why* the values aren't reaching the container
before changing the option-loading logic further.

## 1.0.0 - 2026-08-02

First tracked release notes; the add-on has shipped for a while but this is the first version to
carry a changelog. Highlights:

- **World time**: fixed the per-city forecast sheet coming up empty for zones that hit local
  midnight while other zones are mid-afternoon (an `hourCycle: 'h23'` quirk on some WebViews
  formats midnight as "24" instead of "0"). The home clock card now reads "Georgetown" instead of
  the generic "Home".
- **Weather radar**: the precipitation layer was silently requesting a zoom level RainViewer
  doesn't serve, so every tile came back as a "Zoom Level Not Supported" placeholder image instead
  of rain. It now fetches at a zoom RainViewer actually supports and scales that layer to line up
  with the basemap. The basemap also switched to retina (`@2x`) tiles, so city-name labels are
  legible instead of blurry.
- **Security and other wall-display tiles**: the tile icon was a fixed pixel size while the value
  text scaled with viewport width, so a section with few tiles (Security, in particular) ended up
  with an oversized reading next to a tiny icon. Icon sizing now scales in step with the text.
- **New Volvo page**: a dedicated section that scans for any `volvo.*`-named entity Home Assistant
  exposes (battery, range, odometer, lock state, and more) and lays them out with 24-hour battery
  and range history charts, the same zero-config pattern already used by Energy and presence.
- **Backend**: the Home Assistant API client was capped at a single HTTP connection, serializing
  every concurrent request from the dashboard through one socket; raised to a real connection pool.
  External upstream calls (weather, flights) previously opened a brand-new HTTP client — and paid
  a fresh TCP/TLS handshake — on every single request; they now share one keep-alive client.
