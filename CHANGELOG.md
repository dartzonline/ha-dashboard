# Changelog

Home Assistant's Supervisor shows this file's newest entries as the add-on's "What's new" release
notes, so every version bump in `config.yaml` gets a matching entry here.

## 1.2.1 - 2026-08-03

World time map enhanced for wall-mounted viewing. Removed the instructional text overlay to reclaim
vertical space; the map now fills most of the viewport for easier exploration. Satellite imagery
contrast and saturation were increased to improve legibility from across the room. The day/night
gradient remains prominent to quickly identify active hours at a glance.

## 1.2.0 - 2026-08-02

Header rebuilt around the flight. The banner is now the centrepiece: a large horizontal aircraft
silhouette, airline logo, callsign, type and distance, with origin/destination kept small. Captions
were replaced by symbols — a locate mark for whatever is overhead, a crosshair for a pinned flight —
so the words go to the flight rather than to labelling the mode. A pinned flight also shows how far
along the route it is, its ETA, and a delay chip that reads green on time, amber for a slip, red for
a real delay (an unknown delay stays neutral rather than claiming good news).

To free that space, the activity log and rotation timer moved to the far left beside the page title
and shrank, and the connection indicator is now a single icon with a corner count instead of a
word.

## 1.1.1 - 2026-08-02

Fixes the header aircraft badge never appearing. The shared home-coordinates helper picked the
first *entity that existed* rather than the first one with usable coordinates — and on this install
`weather.forecast_home` is present but publishes no latitude, so the lookup stopped there and
returned "no home location" even though `zone.home` had them. With no coordinates the badge never
queried for nearby aircraft and rendered nothing at all. It now tests each candidate for real
coordinates and falls through, so the badge shows on every page. The same helper backs the service
panel's weather check, which had been reporting Weather as unconfigured for the same reason.

## 1.1.0 - 2026-08-02

**Service status panel.** The connection indicator in the header is now a button. Tap it and it
expands into a card listing every service the dashboard depends on — Home Assistant, flight
positions, flight schedules, weather, rain radar — each with its real state and, when something is
wrong, the specific thing to do about it. This exists because of the 1.0.2 bug: the flight board
degrades to an empty list whether the sky is quiet, a key is missing, or OpenSky is rate-limiting,
and there was no way to tell those apart from the screen. Now there is.

**Aircraft badge in the header.** The slot between the page title and the clock now shows the
nearest *airliner* overhead — an aircraft silhouette picked from its type (twinjet, widebody,
four-engine, regional, turboprop, business jet), the airline's logo, callsign, and origin →
destination. Light aircraft, helicopters and business jets are filtered out; Georgetown Municipal
is a training field, so without that filter this would show a Cessna doing circuits most of the
day. When a flight is pinned from the Flights page, the badge alternates between the pinned flight
and the nearest one every 30 seconds, labelled so the two are never confused.

**Automatic entity discovery is live.** Home Assistant's entity/device/area registries are now
read over the WebSocket API, which is the only place `entity_category`, `area_id` and
`disabled_by` exist. New devices are classified into a section, tile kind and icon, and offered in
a **New devices** tray in Configure — suggest-and-confirm, never a silent auto-add, since a wrong
tile on a wall display is worse than one placed by hand. Dismissals persist. A dry run over this
household's real 833 live entities: 621 correctly ignored as diagnostic/config noise, 5 proposed,
86 flagged for review. Two rules came directly out of that run — companion-app phone telemetry
(step counts, SSID, storage) is skipped by recognising devices that own a `device_tracker`, and
helper domains (`input_*`, `timer`, `notify`, `calendar`) never earn a tile.

**Visual redesign.** A calmer, warmer palette replaces the neon-cyan-and-glow treatment: one
restrained accent used sparingly instead of as system-wide decoration, the technical grid
background removed, gradient bezels and glow shadows dropped, and ALL-CAPS tracking pulled back to
the few tiny labels where it earns its place. Also fixed a real contrast bug — the active tile icon
was rendering dark-on-dark and was effectively invisible.

**Louder, clearer state alerts.** State-change toasts are substantially bigger and now colour-coded
by meaning across every domain: red when something opened, turned on or unlocked; green when it
closed, turned off or locked. Colour is carried by three agreeing signals (edge, filled icon chip,
tinted surface) so it survives the after-sunset auto-dim. The activity log uses the same language.

**Rotation resumes by itself.** Interacting with the dashboard pauses page rotation so the page
being used doesn't slide away — but that pause now expires after 90 seconds, so a wall panel
doesn't sit on one page forever because somebody brushed past it. Pressing the rotation button is
still a deliberate, indefinite hold. Rotation also no longer advances behind an open sheet.

## 1.0.2 - 2026-08-02

**The actual Flights fix.** The 1.0.1 diagnostic logging paid off immediately:

```
[addon_entrypoint] failed to read/parse /data/options.json: [Errno 13] Permission denied
```

The container has run as a non-root user (`USER 10001:10001` in the Dockerfile) since the
OpenSky/AirLabs Configuration-tab fields were added. Supervisor writes `/data/options.json`
world-unreadable (root-only) because it can hold secrets — this add-on's own client secret and
API key among them — so that non-root user could never read it. `addon_entrypoint.py` failed
silently (by design, for native/Compose runs where the file legitimately doesn't exist) and the
add-on has been running with those options unset since they were introduced, regardless of what
was ever filled in and saved on the Configuration tab. It only presented as "Flights broke" now
because OpenSky's free anonymous tier — which is what every request was actually landing on —
finally hit its rate limit.

Removed the non-root `USER` from the Dockerfile; Home Assistant add-ons default to running as
root precisely because Supervisor's mounts assume it. Update to this version, restart, and
`opensky.configured` should read `true`.

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
