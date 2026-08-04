# Changelog

Home Assistant's Supervisor shows this file's newest entries as the add-on's "What's new" release
notes, so every version bump in `config.yaml` gets a matching entry here.

## 1.3.1 - 2026-08-04

Flights that sat on "Awaiting" while they were demonstrably in the air. Three separate causes, all
of which looked identical on screen:

**A flight number is sold by one airline and flown by another.** AA3456 is in the sky transmitting
ENY3456, so a scan for the exact callsign never found it and the pin waited forever. The scan now
also accepts an aircraft broadcasting the same flight number under a different airline's
designator — but only one that is airborne on the corridor between that flight's own scheduled
origin and destination and pointed at the destination. Without a known route to check against, or
for an aircraft that fails any of those, it is refused rather than guessed at: a wrong aircraft on
the map is worse than an honest wait. Verified live against the current sky — AA3656, AA3667 and
AA3915 all track now, through Envoy's callsigns.

**Anonymous OpenSky answers `429 Too many requests`, and that was being read as "no position".** A
tracked flight would flip to "Awaiting" between polls and back again. A rate-limited fetch now falls
back to the aircraft's last known position for a few minutes instead of dropping the flight; a fetch
that succeeds and returns nothing still clears it, because then the aircraft really has stopped
reporting.

**The board was causing its own rate limiting.** Each unresolved pin scanned the entire planet on
every ten-second poll — six pins meant thirty-six full-planet queries a minute. One snapshot is now
shared by the whole board for a cache lifetime.

"Awaiting" also says which of those it is, on the flight's card: no aircraft transmitting that
callsign (with a note that codeshares fly under the operating airline's callsign, and that
`AIRLABS_KEY` follows those), the aircraft known but quiet, or the feed itself not answering — that
last one naming `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`, which raise the limit. A genuine
codeshare like AA9195, sold by American and flown Hyderabad–Delhi by a partner, still cannot be
followed live without a schedule key, but its route is drawn on the map and the card now says why.

The route map no longer draws an aircraft on the origin when there is no position for it — the
route is shown, without pretending to know where on it the flight is.

## 1.3.0 - 2026-08-03

A tracked flight is now shown on a map. Once both ends of a route have resolved, the top half of
the Track page becomes the route itself: the great circle drawn over real dark map tiles, origin and
destination marked in the dashboard's own accent and warn tones, and the aircraft sitting on the
stretch it has already flown — solid behind it, dashed ahead. The map picks its own zoom to fit the
route, so a hop across Texas and a transpacific leg are both legible, and it follows the great
circle rather than a straight line: a San Francisco–Shanghai flight arcs past the Aleutians and
across the date line the way it actually flies. With several flights pinned the map cycles through
them every 20 seconds, and tapping a card holds it there. The rotating aircraft-icon showcase now
appears only when nothing is being tracked, which is what it was for.

Every pinned flight gets a full card. Previously the first flight got a detail card and the rest got
a one-line row each, so half the board was unreadable; now each card carries the route, progress,
times, delay and telemetry, and they flow into as many columns as the screen allows.

The header's flight banner no longer collides with the clock. It sat in a row that centred it in
whatever space was left over, so it drifted with the length of the page name and, on the Flights and
Weather pages, ran underneath the time. The header is now a three-column grid whose columns cannot
overlap, and the rotation timer beside the clock has a fixed-width label so the banner stops
stepping sideways when it changes between "20s" and "Paused".

The world map's night side is lit. It was a black wash over a daytime photograph; it now shows
NASA's Black Marble — the same globe photographed at night — so night is cities in the dark with a
deep blue dusk over them, against the sunlit Blue Marble on the day side. The boundary between them
is the real terminator, computed from today's solar declination and this minute's subsolar
longitude and blurred into a twilight band, so the August Arctic stays lit around the clock and
Antarctica stays dark.

Route endpoints now travel with their coordinates (`fromLat`/`fromLon`/`toLat`/`toLon` on
`GET /api/flights/track`), which is what the map draws from. Covered by new tests on both sides:
the route payload including half-resolved routes and airports with no coordinates, and on the
frontend the projection, the great-circle arc, date-line unwrapping, and that every tracked flight
renders a card.

## 1.2.5 - 2026-08-03

Tracking a flight now lasts until the flight actually concludes. Two things were cutting it short: a
schedule feed reporting the *previous* leg of the same flight number as "landed" retired a flight
that had only just taken off, and a hex address resolved from a stale scan — callsigns get reused
day to day — left the pin stuck waiting on an aircraft that was never going to appear. A live
airborne aircraft now outranks the schedule, a hex that stops reporting is re-resolved, and a gap in
OpenSky coverage no longer counts against a flight that has been seen flying. A landed flight
lingers for half an hour instead of ten minutes.

Several flights can be tracked at once — up to six — and the top banner rotates through all of them
alongside whatever passenger jet is overhead, a dot per slot showing where it is in the cycle. The
Track page lists everything pinned with its route and status, each row with its own remove button,
and the old Stop button is now "Clear all". Pinning adds to the board instead of replacing it, and
the input clears so flights can be added one after another.

The airline logo moved out of the cramped identity row into its own panel on the right of the
banner, roughly four times the size and on a lighter backing so dark or transparent artwork still
reads.

Backed by new tests on both sides: pin expiry rules, board capacity and eviction, and per-flight
un-pinning on the backend; banner rotation, the slot indicator and logo placement on the frontend.

## 1.2.4 - 2026-08-03

The top-bar aircraft silhouette renders again. It was drawn with a CSS mask, and a mask that cannot
load its image degrades silently to a solid coloured block — which is what the header had been
showing. The artwork is now inlined as real SVG, so there is no asset URL left to fail behind Home
Assistant's ingress path. `a350.svg` shipped as a saved 404 page rather than a drawing and has been
dropped; A350s now use the A330 twin-widebody profile. A pinned flight and an overhead one share the
same silhouette lookup, so both draw the aircraft that is actually flying.

A tracked flight now states whether it will land when it said it would: "Arrives 18:40" with "On
time" in green, a small slip in amber, and a real delay in red as "45 min late". With no schedule to
go on it falls back to the live time-to-run from ground speed.

The frontend has a test suite now (`npm test`, Vitest + Testing Library). It covers the type-to-
silhouette mapping, the arrival verdict thresholds, and — so this class of bug cannot return — a
check that every bundled aircraft asset is real drawable geometry rather than an error page.

## 1.2.3 - 2026-08-03

Top-bar flight banner: aircraft silhouette is now larger and brighter (dominant), and the aircraft
type string is no longer shown — the silhouette itself communicates the type visually.

## 1.2.2 - 2026-08-03

Layout cleanup across the wall display and a new Track page. The stray border around the screen is
gone, scrollbars are hidden, and the Insights, Weather, Energy and Flights views no longer overlap
their header or overflow the viewport. Volvo was rebuilt around exception-only status chips with
full-height charts. World time gives the clock column enough room that city names stop truncating,
and the night shading is deeper. The Flights radar scope fills its panel again, and the Track page
now splits in half: a rotating widebody showcase (747, A380, 777, 787, A330, A340, 767, MD-11) over
a radar-style stage above the flight-number form. Aircraft artwork uses the free SVG icon set from
ADS-B Radar for macOS (https://adsb-radar.com).
and the top-bar flight badge now uses the same ADS-B Radar icon pack as the Track showcase, and the
route/type data can fall back to ADS-B DB's combined aircraft endpoint for better accuracy. The Track
page now splits in half: a rotating widebody showcase (747, A380, 777, 787, A330, A340, 767, MD-11)
over a radar-style stage above the flight-number form, and the showcase can be swiped manually.

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
