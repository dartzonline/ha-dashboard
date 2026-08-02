# Plan: automatic entity discovery

**Status:** not started — planning only.
**Goal:** when a new entity shows up in Home Assistant, it should appear on the dashboard in a sensible section, with the right tile kind and (where useful) a chart, without anyone hand-editing `dashboardConfig.ts` or the Configure panel.

This document is the design for that. It's written to be picked up cold in a future session.

## Where we already are

Three pieces of this problem are **already solved**, just not generalized:

1. **Charting is already automatic, not tile-driven.** `EntityTile` in `frontend/src/App.tsx` shows a `Sparkline` for *any* tile with `kind: 'sensor'` and a numeric state — that's already generic, keyed off `kind`, not off a hardcoded entity list (`useSparkline.ts`). `EntityDetails` shows a `StateTimeline` for *any* discrete-domain entity (`light`, `switch`, `lock`, `cover`, `binary_sensor`, `media_player`, `vacuum`, `fan`, `climate`) with no numeric history, again with no per-entity config. **The only real gap is getting a tile to exist in the right place at all** — once it exists, charting is free.
2. **`EnergyView` (`frontend/src/useEnergy.ts`) doesn't use `dashboardConfig.ts` at all.** It scans `entities` for `device_class: 'energy'` at render time and builds its own cards/chart. New energy sensors show up with zero config changes, today.
3. **`PresenceRow.tsx`** does the same thing for `person.*` — scans the live entity map, no tile config.

So the actual shape of this project is: **generalize the EnergyView/PresenceRow pattern** (scan live entities, classify, render) to the parts of the dashboard that are currently static tile lists (`home`, `climate`, `security`, `lights`, `appliances`, `roborock`, `scenes`), while keeping a human in the loop for placement decisions that are ambiguous or safety-adjacent.

## Non-goals

- **Night Mode's indoor-light allowlist stays manual, always.** `NIGHT_MODE_INDOOR_LIGHTS_DEFAULT` / `NIGHT_MODE_PROTECTED_TERMS` in `backend/app/main.py` gate a routine that locks/unlocks and closes physical devices. Auto-adding a light to *dashboard display* is low-risk; auto-adding it to *the list of lights Night Mode is allowed to switch off* is not. This plan does not touch that allowlist. (The Configure panel already lets a human add a light there deliberately — see `ConfigPanel.tsx`'s Night Mode tab.)
- **Not a general HA "auto-dashboard" clone.** We're extending this app's existing function-based sections (Lights, Security, Climate, Appliances, Roborock, Scenes), not building a new area/room-based layout system.
- **Not solving stale-tile cleanup in this pass.** Entities that get renamed or removed currently leave a dead "Unavailable" tile forever. Related problem, worth a follow-up doc, out of scope here.

## The hard part: Home Assistant's REST API doesn't expose registry metadata

`backend/app/ha_client.py` only talks to `/api/states` (and history/services). That endpoint gives you `entity_id`, `state`, and `attributes` — it does **not** give you `entity_category` (diagnostic/config vs primary), `area_id`, `device_id`, or `disabled_by`/`hidden_by`. Those live in Home Assistant's *registries*, which are only reachable over the **WebSocket API** (`config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`).

This matters because without `entity_category`, naive discovery will surface diagnostic noise (firmware version sensors, RSSI, update entities, etc.) right alongside things worth a tile. Filtering on domain alone isn't enough.

The good news: `backend/app/event_bridge.py` already maintains a persistent authenticated WebSocket connection to Home Assistant, with a request/response pattern (`call_service` already does exactly this: send `{id, type, ...}`, await the matching `result` message via `self._pending`). Fetching the registries is the same mechanism, not a new one.

**Phase 0 (foundational, no user-visible change):**
- Add `EventBridge.send_command(command_type: str, **kwargs) -> Any`, generalizing the existing `call_service` request/response plumbing.
- Add `backend/app/entity_registry.py`: fetches `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list` on demand, joins them (entity → device → area), caches in memory (~5 min TTL, same style as `flights.py`'s caches).
- Expose `GET /api/registry` returning the joined, minimal shape the frontend needs:
  ```json
  {
    "entities": {
      "light.kitchen": { "areaId": "kitchen", "category": null, "disabled": false, "hidden": false },
      "sensor.rssi_router": { "areaId": null, "category": "diagnostic", "disabled": false, "hidden": false }
    },
    "areas": { "kitchen": "Kitchen" }
  }
  ```
- Verify the configured token has permission for these WS commands (should be fine for an admin long-lived token or the Supervisor token in add-on mode — worth confirming against a real instance before building on it).

Everything downstream depends on this existing. Do it first, in isolation, and sanity-check the output against the real 825-entity household before writing any classification logic.

## Classifying an entity: section, kind, icon

New module: `frontend/src/entityClassifier.ts`. Pure function, easy to unit-test:

```ts
function classify(entity: HAEntity, registry: RegistryMeta | undefined): TileProposal | 'skip' | 'review'
```

Rule table (first pass — domain and `device_class` first, naming heuristics as fallback, same style already used throughout this codebase in `UtilityRail`, `SecurityPanel`, and `useEnergy.ts`'s `WHOLE_HOME_HINTS`):

| Match | Result |
|---|---|
| `registry.category` is `diagnostic` or `config`, or `disabled`/`hidden` | **skip** |
| `person.*`, `device_tracker.*` | **skip** — already handled by `PresenceRow` / `UtilityRail`'s aggregate device count |
| `sensor.*` with `device_class: energy` | **skip** — already handled by `EnergyView` |
| `sensor.*` with `device_class: battery` | **skip** — already aggregated in `UtilityRail`'s low-battery ranking; a standalone tile is redundant |
| `light.*` | `lights` section, `kind: 'toggle'`, icon `lightbulb` |
| `lock.*` | `security` section, `kind: 'lock'`, icon `lock` |
| `cover.*` with `device_class: garage` or name contains "garage"/"gate" | `security` section, `kind: 'sensor'`, icon `warehouse` (matches the existing `cover.ratgdov25i_8e54c8_door` tile) |
| `cover.*` (other) | `lights` section, `kind: 'toggle'` |
| `climate.*` | `climate` section, `kind: 'thermostat'`, icon `thermometer` |
| `vacuum.*` | `roborock` section, `kind: 'vacuum'`, icon `bot` |
| `sensor.*`/`switch.*` whose device shares a `device_id` with a `vacuum.*` entity (filter/brush life, DND, child lock) | `roborock` section |
| `media_player.*` | `appliances` section, `kind: 'toggle'`, icon `tv` |
| `binary_sensor.*` with `device_class` in `{door, garage_door, window, opening, moisture}` | `security` section, `kind: 'sensor'` |
| `switch.*` — reuse `safe_lighting_switch`-style naming heuristics (already in `backend/app/main.py`) | light/lamp-named → `lights`; appliance-named (washer/dryer/fridge) → `appliances`; else **review** |
| `sensor.*` with `device_class` in `{temperature, humidity}` | `climate` section (matches the existing per-room temperature tiles) |
| `scene.*`, `script.*` | `scenes` section, `kind: 'sensor'` |
| Anything else, or ambiguous | **review** — surfaced to the human, not auto-placed |

Optional, higher-value enhancement once `registry.areaId` is available: let the user map **HA areas → sections** once (e.g. "Garage" → `security`, "Laundry Room" → `appliances`) in the Configure panel, persisted alongside the rest of `/api/config`. Then classification for ambiguous domains (mostly `sensor.*`/`switch.*`) can fall back to the area mapping before landing in "review." This scales much better than per-entity rules as a household adds more devices to rooms it's already mapped.

## Where this runs, and how a human stays in the loop

New hook: `frontend/src/useEntityDiscovery.ts`.

1. Fetch `/api/registry` once per session (or on a slow poll).
2. Build the set of `entityId`s already referenced by *any* tile in the current effective `sections` (from `useDashboardConfig`), plus anything on a persisted **dismissed list** (see below).
3. For every entity in `entities` (already in memory from `useHomeAssistant`) not in that set, run `classify()`.
4. Return `{ proposals: TileProposal[], needsReview: HAEntity[] }`.

**Default behavior is suggest-and-confirm, not silent auto-add.** This is a real household's wall display — a misclassified tile (or one that shouldn't exist at all) is more annoying discovered *after* it's live than before. Extend `ConfigPanel.tsx` with a banner/tab: "**12 new devices found**" → list with the proposed section/label/icon pre-filled (reusing the row UI that already exists for manually-added tiles), each with **Add**, **Edit then add**, or **Dismiss**. A **dismiss** persists the entity id to a new `ignoredEntityIds: string[]` field on the config payload (extend `DashboardConfigPayload` in `backend/app/dashboard_config.py` and the frontend `DashboardConfigResponse` type) so it doesn't get re-suggested every session. Accepting a proposal is just calling the existing `save()` with the entity appended to the target section's tiles — no new persistence path needed, this reuses `/api/config` exactly as it exists today.

For households that want zero-touch: a per-domain "auto-accept" setting (e.g. "automatically add new lights and switches without asking"), stored the same way, checked before landing something in the confirmation tray instead of just auto-saving it.

Entities that land in **review** (classifier returned `'review'`) get a separate, lower-urgency list — worth a badge/count somewhere, not a blocking prompt.

## Phasing

1. **Registry plumbing** (`EventBridge.send_command`, `entity_registry.py`, `GET /api/registry`) — no UI change. Validate output against the real house.
2. **Dry-run report.** Run `classify()` over the real 825 entities, log/print a breakdown (counts per section, per skip-reason, per review-bucket) *before* wiring up any UI. This is the cheap way to catch a bad rule (e.g. a domain that over-matches) without it ever reaching the live dashboard.
3. **Configure panel "New devices" tray** — manual accept/dismiss per entity. This is the safe default and probably where this ships for a while.
4. **Auto-accept setting**, opt-in, per domain.
5. **Stretch:** area → section mapping UI; a companion pass on stale/unavailable tiles (entities that disappeared, prompting "remove this tile?").

## Open questions to resolve before implementation

- Does the configured `HA_TOKEN` (or `SUPERVISOR_TOKEN` in add-on mode) actually have permission for `config/entity_registry/list` etc.? Confirm against a real instance in phase 1 before building further.
- Registry fetch adds a second concern to `EventBridge` beyond event streaming — decide whether it shares the existing persistent connection/lock or opens a short-lived second connection for registry calls, to avoid contending with `call_service`'s use of the same `_pending`/`_send_lock`.
- Multi-vacuum-brand households: the `roborock` section is Roborock-specific by name. Fine for this house; worth a rename (`vacuum`?) if this ever needs to generalize beyond one brand.
- How noisy is "review" in practice? If a large fraction of real entities land there, the domain/device_class rule table needs more cases before this is worth shipping — that's exactly what the phase-2 dry-run report is for.
