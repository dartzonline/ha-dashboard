# Changelog

Home Assistant's Supervisor shows this file's newest entries as the add-on's "What's new" release
notes, so every version bump in `config.yaml` gets a matching entry here.

## 1.15.0 - 2026-09-28: UI overhaul

**A new look: liquid glass, tuned for reading across a room.** Every panel is now a pane of dark,
lightly frosted glass over a softly lit background, with larger corner radii and one consistent
header, empty, loading and error style on every page. The glass is a finish, not a see-through
effect. Panes are mostly opaque, every piece of text sits on one, and all text colours clear WCAG
AA contrast even over a bright photo backdrop. Disabled buttons now say so with colour rather than
fading out. Older tablets that cannot blur fall back to solid panes automatically, as do devices
set to reduce transparency. Charts share one colour set that stays distinguishable for colour-blind
readers, with a legend and tooltip on each; the network chart no longer uses two y-axes. The
Manrope font is now bundled, so a panel with no internet no longer waits on a font server.

**The panel keeps itself up to date after an outage.** Previously a Wi-Fi blip or a Home Assistant
restart left tiles showing whatever they said before, until each entity happened to change again.
The panel now reloads every state when it reconnects, the backend tells it when its own link to
Home Assistant comes back, and a silent connection is detected and restarted. A banner says when
readings may be stale, and a separate one says when Home Assistant has rejected the backend's
token, which reconnecting cannot fix. Health is re-checked every 30 seconds instead of once at
startup, so Night Mode is no longer stuck disabled if Home Assistant was down when the panel loaded.

**Kiosk behaviour.**
- The page is kept in the address, so a kiosk reload returns to the same page and slide. A manual
  rotation hold also survives a reload.
- The tablet's Back button closes an open sheet instead of leaving the app.
- Sheets close on Escape, keep keyboard focus inside them, and close themselves after two minutes
  of no touch, so a brushed tile no longer parks the panel on a sheet forever.
- Night Mode, Home Assistant updates, photo deletion and the network restart use tap-again-to-confirm
  instead of the browser's confirm dialog, which some kiosk browsers suppress.
- Every control is at least 44px, including the rotation button, slide pagers and thermostat
  steppers. Swiping no longer changes page when the gesture started on a map, chart or scroll row.
- The clock ticks on the minute instead of up to 30 seconds late, and the rotation chip shows a
  live countdown.
- Readings keep their units as written: kWh no longer turns into "KWh".

**Less load on the backend and the flight APIs.** The Maintenance page no longer refetches in a
tight loop while on screen. The service status panel no longer re-probes three services on every
state change. Energy history is cached for 30 minutes instead of refetched on every rotation, and
the header badge and the Flights page now share one flight poller that pauses when the screen is
hidden. Network speed conversions were about 5% low and are fixed.

**Backend hardening.** No login is added: the panel stays open on your LAN by design.
- The service endpoint only accepts the device domains the dashboard uses. Anything else, such as
  a restart or a shell command, is refused.
- The media artwork proxy no longer sends the Home Assistant token to third-party image hosts like
  Spotify's.
- Adding a photo by web address refuses local and private network addresses.
- Photo uploads are size- and pixel-checked before processing, so an oversized image can no longer
  exhaust memory. Processing runs off the main loop, so live updates do not freeze during an
  upload.
- The photo library, dashboard layout and flight quota files are written atomically, and a damaged
  photo index is rebuilt from the files on disk.
- Setting `airlabs_daily_budget` or the energy rate to 0 now takes effect instead of being ignored.
- Flight ETAs are sent as timestamps, so the panel shows them in its own timezone.

## 1.11.0 - 2026-08-23

**Photos now appear behind the dashboard**, on the five pages quiet enough to carry one: Climate,
Security, Appliances, Lights and Scenes. These are the plain tile-grid pages — a handful of cards on
an otherwise empty canvas, so there is real space for a picture to be seen in. Everything else is
deliberately left alone: Insights, Energy, Network, Health, Maintenance and Volvo are wall-to-wall
charts; World, Flights and Weather are full-bleed maps and atmospheres that already fill the screen
with their own imagery; Home carries the moments strip and utility rail on top of its tiles; and the
Photos library page would have a backdrop competing with the thumbnails it exists to show.

One picture per page, and a different one on each — the nth page in the list takes the nth photo in
the library, so a page keeps its own picture rather than every page showing the same one. The
assignment is stable, so a page does not flicker through pictures as the panel rotates, and it
re-reads the library only every fifteen minutes.

The treatment is **cinematic**: the photo stays sharp and recognisable, darkened to 62% with a
diagonal scrim that is heaviest at the top-left where the header and the first tiles sit, plus a
vignette. The darkening is done by a scrim over a full-strength photo rather than by fading the
photo itself, which would turn it into flat grey mush and lose the colour that makes it worth
showing. Two alternative treatments are built and one word apart in `PhotoBackdrop.tsx` — `dim`
(blurred and much darker, reads as texture rather than a picture) and `duotone` (greyscale, tinted
toward the dashboard accent). The backdrop is decoration only: `aria-hidden`, no pointer events, and
it disappears entirely when the library is empty, so a panel with no photos looks exactly as before.

Also fixed, found while testing this with real photographs: processing could make a file **bigger**.
An image that arrives already heavily compressed costs more to re-encode at the default quality than
it did to store originally — five real sample photos all grew by 15–25%. Quality now steps down a
ladder until the stored copy fits within the size that arrived, which turned those same five into
8–12% *savings*.

## 1.10.0 - 2026-08-23

**A Photos page**, for building a personal picture library on the panel. Add pictures from the
device you are holding (file picker or drag-and-drop, several at once) or by pasting a web address.
Where these pictures get *displayed* is still an open question and deliberately not decided here —
this release is the library and the management screen only, so the display choice can be made
without rebuilding any of it. The page is excluded from the unattended page rotation, since a screen
full of upload and delete controls is not something to leave a wall panel sitting on.

**Every picture is processed on the way in** rather than stored as-uploaded. A phone photo is around
4000px and several megabytes; the panel is 1080p-class and will never show more than a fraction of
that. On add, each image is rotated upright per its EXIF orientation (a phone stores a portrait shot
as landscape plus a "rotate me" tag, which an `<img>` ignores and shows sideways), scaled to fit the
panel without ever being enlarged, re-encoded at a visually-lossless quality, and stripped of its
metadata — which is also where the GPS coordinates live, and those have no business being served to
a wall display. A real 3.7 MB, 4032×3024 phone photo comes out at 852 KB and 2048×1536: **78%
smaller**, with nothing visible lost at arm's length.

**A thumbnail is generated alongside** (~40 KB), so the manage screen shows the whole library at
once without pulling down full-size images to draw small tiles. Each one has its own remove button
and arrows to change the running order, and the tile says what the picture cost before and after
processing.

**Tapping the clock** in the top-right now opens World time, matching how the flight banner already
opens Flights — a live value in the header goes to the page it summarises. Two utility-rail cells
were pointed at more useful destinations while in there: Network now opens the Network page rather
than the generic Insights connectivity slide (that page did not exist when the cell was written),
and the tablet battery cell opens Health, which is where battery entities are actually listed.

## 1.9.0 - 2026-08-23

**A pinned flight's progress bar and route map now actually move.** The bug: a flight's progress
fraction needs both airports' coordinates to compute at all, and the local `AIRPORTS` table only
ever covered a handful of fields near home — any destination outside it (Midland, for a Houston
departure; anywhere at all, for most flights) had no coordinates, so the progress bar sat at 0% for
the entire flight regardless of how far it had actually gone. A bundled worldwide airport dataset
(8,700+ fields, generated from OurAirports' public-domain data by `backend/scripts/build_airports_data.py`)
now fills that gap for any airport code a schedule feed hands back. Verified live: a Houston→Midland
flight that was stuck at 0% moved to 92%, then 96%, as it actually approached; a Miami→San Francisco
flight climbed from 42.95% to 43.25% across two ordinary ten-second polls.

**The route map now draws where the aircraft actually flew, not a straight guess.** It previously
interpolated a point along the ideal origin-destination great circle and called that "flown" — a
made-up position, not a fact. It now fetches the aircraft's real historical track (OpenSky's
`/tracks/all`, keyless and already scoped to one flight leg; adsb.lol's per-aircraft trace history as
a fallback, correctly segmented to the current flight by matching the callsign the aircraft actually
transmitted rather than by an aircraft's last "on the ground" sample — traces routinely start already
airborne mid an earlier leg, which the first version of this got wrong). The map now draws three
distinct lines: the idealised great-circle route (faint, always the full origin-to-destination
plan), the real flown track since departure (solid, bold), and a freshly-recomputed great circle from
wherever the aircraft actually is now to the destination — correct even after a real deviation, unlike
re-using the back half of the original plan. The same fix applies to the multi-flight overview map.

**Flight-number resolution is more robust.** A flight sold by one airline and flown by a regional
affiliate under a different callsign (AA3456 flying as ENY3456) is now found by matching the flight
number and checking the candidate is actually airborne on the pinned flight's own corridor, heading
toward its destination — refused rather than guessed at if it fails either check. A genuine codeshare
(a flight number sold by one airline, flown under a completely different number by the operating one)
still cannot be followed live without a schedule key, and the board says so rather than leaving
"Awaiting" unexplained.

A **Maintenance** page addition: pending software/firmware updates, read from Home Assistant's own
`update.*` entities — Home Assistant Core, Supervisor, OS, and anything an integration publishes one
for (ESPHome device firmware, HACS components). Nothing here is guessed or version-compared by this
app; `state == "on"` is Home Assistant's own conclusion that a newer version exists, including
correctly not re-nagging about a version already skipped. Each pending update is its own tile with an
Install button that calls `update.install` directly — installing Home Assistant's own core or
supervisor asks for confirmation first, since that can briefly restart the add-on this dashboard runs
as. An update already in progress shows its live percentage instead of a button, and the page polls
every 10 seconds while one is running rather than its usual 5 minutes.

## 1.8.0 - 2026-08-13

A **Maintenance** page for the things that wear out rather than break — the quiet signals nobody
notices until a filter has been at 0% for a month.

**Consumables**, ranked worst-first as bars. Devices report these in incompatible units: the vacuum
counts down *hours remaining*, the fridge and air purifier report *percent of life left*. Both are
normalised so one panel can rank them against each other. The hour-based percentages are computed
against the manufacturer's service intervals — the vacuum never reports a percentage — and the page
says so rather than passing a derived figure off as a device reading.

This immediately surfaced the fridge's fresh-air and water filters at **0%**, and the vacuum's dust
sensor **31 hours past** its service interval. A negative remainder is reported as overdue rather
than clamped to zero, which would have read as merely "empty".

**Water softener salt** trusts the depth sensor over the tank's own percentage, because on this
install the percentage collapsed from 60% to 0% while the depth reading barely moved (43.5cm →
42.1cm). Trusting it would demand a refill that isn't needed, so the page reports ~32% from depth
and says plainly that the percentage sensor looks miscalibrated instead of hiding the disagreement.
The depth scale is inverted — more centimetres means less salt, since the sensor looks down at it.

**Garage door** shows position, obstruction, limit switches, and the number that actually matters:
opening and closing travel time (12.9s / 10.9s). A door that gradually takes longer to travel has a
spring or roller problem developing. Home Assistant records the value but nothing watches it for
drift, so it is surfaced with a link to its history.

**Appliance wear** gives cycle counts and month-over-month energy. A rise is tinted, a fall is not:
an appliance drawing more power without being used more often usually means a failing door seal.

**Device faults** are pulled to the top of the page. Integrations publish a fan-out of `fault_*`
sensors that are almost always `off` and therefore invisible; when one trips it should be the
loudest thing on screen. One is live here — the Roborock dock's clean-water box.

Also fixed while building this: the dust-sensor consumable had a service interval defined but
matched none of the name hints used to find wear items, so the one genuinely overdue thing on this
install was silently dropped before it could be ranked. Caught by a test, not by eye.

## 1.7.0 - 2026-08-13

Three new pages, and one of them found real faults on day one.

**Health** — a single page answering "does anything need me?", built from signals Home Assistant
already publishes but never draws attention to. On this install it immediately surfaced:

- **Automatic backups had been failing for 81 days.** A backup was attempted every day; the last
  one that *succeeded* was in May. Both sensors read as healthy on their own — the fault only
  exists in the gap between `last_attempted` and `last_successful`, which nothing was comparing.
- A sensor battery at 10%, two refrigerator filters at 0% life, an active Roborock dock problem,
  a door left open, and pending updates including Home Assistant Core itself.

It also detects **stale sensors** — a value that has not moved in far longer than its own cadence.
A lawn-moisture sensor here had been frozen at `0%` for eight days while its sibling updated
normally; Home Assistant flags nothing, because `0` is a valid number. Getting this right needed
two guards: Home Assistant rewrites `last_changed` on hundreds of entities when it restarts, so an
early version read one restart as "110 sensors froze simultaneously" and buried the four findings
that mattered. Restart bursts are now ignored — but only for 36 hours, because a sensor that has
not moved since a restart days ago really has stopped. Batteries and coin-cell voltages are
excluded entirely: sitting at a flat 100% / 3.0V for months is what a healthy one does.

**Entity registry cleanup** — of 836 entities, 217 are `unavailable`, and most are not broken
hardware. Re-pairing a device leaves its old entities behind forever, so `pantry_door_door` is dead
while `kitchen_pantry_door_door` works. Each dead entity is paired with the live one that replaced
it, which is what makes it safe to delete; an entity with **no** live twin might be genuinely broken
or merely asleep, so those are counted separately and never recommended for deletion. Name-based
pairing only applies when the name is unique, so two devices both called something generic can
never cause an unrelated entity to be listed as safe to remove.

**Roborock** — consumable life (filter, brushes, sensors, dock strainer) as progress bars, dock and
maintenance status, lifetime totals, and start/pause/dock/locate controls. Dock faults are called
out rather than buried: this install has a clean-water box needing a refill and a dock reporting
`water_empty`. Consumable intervals are not exposed by Home Assistant, so the percentages are
computed against Roborock's published service intervals and the page says so.

**Volvo** — expanded from a handful of tiles to the ~64 signals the integration actually publishes:
battery and electric range, fuel and range, charging state, odometer and distance-to-service, and a
closures panel covering every door, the hood, tailgate, sunroof and tank lid. It reported the car
unlocked while everything was closed, which is exactly the glance the page is for.

Every card on all three pages opens the underlying entity's detail sheet and history, the same as
tiles elsewhere in the dashboard.

## 1.6.1 - 2026-08-13

The Network page's cards were read-only, unlike tiles everywhere else in the dashboard — they looked
tappable but did nothing. Each one now opens the same entity detail sheet the rest of the app uses,
because each was already fronting a real Home Assistant entity:

- **Download** and **Upload** open their gateway throughput sensors, with the 24-hour history chart
  and now/average/low/high figures.
- **Devices** opens the WAN sensor, whose sheet carries the full network history view.
- **External IP** opens the gateway's IP sensor.
- **Every row in the connected-devices list** opens that client's own `device_tracker`, so you can
  see when a specific phone or laptop has been on the network.

A card whose entity is missing is disabled rather than silently inert, so an unavailable sensor looks
different from a broken button.

## 1.6.0 - 2026-08-13

**Network is now its own page in the sidebar.** The uptime and outage panel added in 1.5.0 was
buried three interactions deep — Home, then the Internet tile, then scrolling inside the sheet — and
was effectively impossible to find. It now has a full-size page alongside Flights and Energy, with
the tile sheet left intact for anyone who liked it there.

The page adds what the empty space below the chart was asking for:

- **Connected devices** — every client the router reports, with IP, hostname and how long it has been
  connected, filterable by name/IP/MAC and sorted numerically by address so `.9` precedes `.10`.
- **Recent activity** — devices joining and leaving, from `device_tracker` history. Home Assistant
  re-reports every tracker at once when it restarts, which looked like forty devices joining
  simultaneously and buried the real comings and goings; those bursts are now filtered out.
- **Router card** — firmware version with an update flag, external IP and its recent changes, WAN
  state, and device counts.
- **A restart button** for the router, behind a confirmation, since a reboot knocks every device off
  for a minute or two.
- **Selectable window** (6h / 24h / 3d / 7d) for all of the above.

**Per-device bandwidth is deliberately absent.** The Netgear integration exposes only two throughput
sensors, both gateway-wide totals, so there is no per-client traffic data to show — the page says so
rather than presenting an invented number.

Also fixed: the router reports `0.0.0.0` while reconnecting, which was being counted as a real
address. One ISP reconnect therefore logged two "IP changes" and displayed an address the connection
was never reachable on. A genuine address change after a reconnect is still reported.

## 1.5.0 - 2026-08-13

The network view showed how fast the internet was, but never whether it had actually been up. It
now tracks outages from the Orbi (CBR750) gateway and reports uptime alongside the speed history.

**Outages are detected from several signals, because no single one sees them all.** The gateway's
own `wan_status` sensor going `off` is the direct answer. Gaps in the throughput sensor's history
catch drops the polled sensor slept through — and, importantly, outages where Home Assistant lost
contact with the router altogether, which no router-reported sensor can witness. External-IP changes
corroborate a WAN session that dropped and reconnected. The same drop seen by two signals a moment
apart is merged, so one outage is counted once.

Verified against real history: a 30-second drop on 13 August at 09:44 was found by the WAN sensor
*and* confirmed by the external IP going `47.221.153.232 → 0.0.0.0 → 47.221.153.232`.

**Every figure says how it was measured, because the honest answer is less precise than it looks.**
The gateway is polled roughly every 30 seconds (measured: median 30.0s, p99 42s), so a shorter drop
can pass between two readings and leave no trace anywhere — the panel reports its own resolution
rather than implying it would have caught a two-second blip. Drops under five seconds are counted
separately as "blips" so a 0.4-second flicker isn't tallied like a twenty-minute failure. Installing
Home Assistant's `ping` integration against an external host would lower that floor, since it is
event-driven rather than polled.

Uptime is measured over the history actually retained, not the window requested. Home Assistant's
recorder keeps far less than a week; asking for seven days and dividing by seven days — when six of
them hold no data — reported **14% uptime on a connection that never dropped**. The panel now states
the observed window ("over 24h observed") so the number can be trusted. Trailing silence is treated
as the end of retained history rather than an outage in progress, which is what produced that
phantom six-day outage.

Connectivity sensors belonging to individual devices are deliberately ignored. A `connectivity`
device_class on a gadget tracks *that gadget's* wifi — a Hatch sound machine briefly dropping off
the network is not an internet outage, and counting it as one would inflate every figure here.

## 1.4.0 - 2026-08-04

The flight screens went blank. The AirLabs allowance had run out, and positions came from OpenSky
alone — whose anonymous tier rate-limits constantly — so there was nothing left to draw. Both halves
of that are now fixed, and neither depends on an API key.

**Positions fall back to three keyless feeds.** When OpenSky returns nothing, the radar and the
tracked flights come from adsb.lol, adsb.fi or airplanes.live, whichever answers first. None needs a
key. They also carry each aircraft's registration and type inline, which saves a separate lookup per
aircraft, and they can answer "which aircraft is flying this callsign" directly — replacing the
whole-planet scan that resolving a pin used to require. Verified with no credentials configured at
all and OpenSky deliberately unreachable: the radar still fills and pinned flights still track.

**Schedules no longer need a key either.** Gate, terminal, baggage claim, delay and live status now
come from a free source, with AirLabs filling anything it misses and cross-checking the rest. Long-
haul routes finally draw properly: a worldwide airport database supplies the coordinates the local
airport table never had, so a Barcelona–Dallas flight gets a real arc and a real percentage instead
of a flat bar.

**A quota cannot be silently drained again.** Every metered call is cached for five minutes and spent
from a persisted daily budget that stops before the cap rather than after it. Polling drops to 30s
for tracked flights and 60s for the radar, and pauses entirely while the dashboard is not on screen.
The status panel reports the feed actually carrying the board and how much allowance is left, rather
than blaming OpenSky while the screen is visibly full of aircraft.

**Every tracked flight on one map.** Rotating through one route at a time never showed two flights
converging on the same airport. The combined view joins the same rotation as one more screen on the
Track page — each route in its own colour with the flight number on the path, landed flights greyed
but still present.

**A landed flight now stays on the board for six hours** instead of thirty minutes. Half an hour
retired flights before anyone looked at them — the gate and baggage claim of an arrival are wanted
after it is on the ground, not only while it is in the air.

**The header banner is now a shortcut.** Tapping a pinned flight opens the tracking map; tapping the
jet overhead opens the radar. The banner and the map both take horizontal swipes to move between
flights, and the dots are tappable for direct selection. Scenes has been dropped from the unattended
rotation — it is a page of buttons to press, not something to watch go by — and stays reachable from
the sidebar and by swipe.

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
