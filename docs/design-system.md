# Design system: liquid glass

The panel is a set of translucent panes over a deep, softly lit canvas. Everything below lives in
`frontend/src/index.css` (tokens, primitives) and `frontend/src/ui/` (shared components).

## Readability comes first

This is a wall dashboard read from across a room. The glass is a finish, not a see-through effect.

- Panes are about 80 to 90 percent opaque dark tint with a 14px blur. The edge light is faint and
  the canvas washes are subtle.
- Text only sits on a pane, never directly on the canvas, a map, a weather scene or a photo.
- Body text holds 4.5:1 contrast and large numerals 3:1. `--text` and `--muted` clear that on every
  pane, including over a bright photo. `--muted-2` is for tertiary hints only.
- Never fade text with opacity to de-emphasise it. Pick a token instead.
- No glass inside glass. A chip inside a glass card uses `--surface-raised`.
- Tone tints are a wash of at most 18 percent on the pane, plus an icon or edge change.
- Disabled buttons are said with colour, never opacity. The label drops to `--muted` on a plain
  raised pane. Toggles are the exception, because they are only disabled while a command is in
  flight.
- Every `PageFrame` heading sits on its own pane.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Canvas and ink | `--canvas`, `--text`, `--muted`, `--muted-2`, `--fg` | `--fg` is an alias of `--text` |
| Glass | `--glass-bg`, `--glass-bg-strong`, `--glass-border`, `--glass-blur`, `--glass-highlight`, `--glass-edge`, `--glass-shadow` | Set once; components use the `.glass*` classes |
| Legacy surfaces | `--surface`, `--surface-raised`, `--border` | Now translucent, so old `background: var(--surface)` rules read as thin glass |
| Accent | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-ink` | Selection, current view, primary action only |
| Status | `--good`, `--warn`, `--danger` plus `-soft` and `-ink` | Always paired with an icon or word. Never used as chart series |
| Chart series | `--chart-1` to `--chart-6`, `--chart-grid`, `--chart-axis`, `--chart-ink` | Fixed order, validated for colour-vision deficiency on the dark canvas. A seventh series folds into "Other" |
| Shape | `--r-sm` 12, `--r-md` 18, `--r-lg` 26, `--r-xl` 34, `--r-pill` | Tiles use `--r-md`, sheets `--r-lg` |
| Touch | `--tap` 44px | Every `button` has this min-height globally. Use `.hit-area` for things drawn smaller |

## Primitives

- `.glass` a pane. `.glass-strong` a more opaque pane for text-heavy sheets and the nav rail.
  `.glass-pill` for chips. `.glass-inset` for a recessed well (sliders, tracks).
- `.tone-accent|good|warn|danger` tints a pane.
- `.on-glass-text` adds a hairline text shadow for copy sitting over a photo backdrop.
- Fallbacks are automatic: no `backdrop-filter` support, `prefers-reduced-transparency`, and
  `<html data-glass="lite">` all drop the blur and go solid. `prefers-reduced-motion` stops
  animation.

## Shared components (`frontend/src/ui/`)

- `PageFrame` the one page sub-heading: icon, eyebrow, title, meta, actions, tone.
- `GlassCard` a pane with the shared radius and edge light.
- `EmptyState`, `LoadingState`, `InlineError` the three data states, drawn one way everywhere.
- `useDialog({ onClose, idleMs })` for every sheet: Escape closes, focus moves in and back out,
  Tab cycles inside, the background becomes inert, and the sheet auto-closes after idle time.
  Elements that should go inert behind a sheet carry `data-dialog-background`.
- `useTwoTapConfirm()` first tap arms, second confirms, auto-disarms. Replaces `window.confirm`.
  Nothing in the app uses `window.confirm` any more.
- `useBackToClose` pushes one history entry while any sheet is open, so the tablet's Back button
  closes the sheet instead of leaving the app.
- `useMediaQuery(query)` for layout decisions that CSS alone cannot make.
- `chartTheme.ts` and `chartKit.tsx` hold the chart presets: `seriesColor(i)`, axis and grid
  styling, `GlassTooltip` and `ChartLegend`. Use them for every new chart.
- `tablist.ts` `tabListKeyHandler` gives any `role="tablist"` arrow-key navigation.

## URL state

The page lives in the hash: `#/<section>` or `#/<section>/<n>`, where `n` is the 1-based slide for
Insights, Weather and Flights. Section and slide changes, including rotation ticks, replace the
history entry rather than adding one. A manual rotation hold is kept in `sessionStorage` under
`hc.rotationHeld`, so it survives a kiosk reload.

## Rules of thumb

- Charts: thin marks, 2px lines, no dual axes, grid in `--chart-grid`, labels in `--chart-ink`.
  Series colours come from `--chart-n` in order. Legends for two or more series.
- Swipe navigation ignores anything inside `[data-swipe-ignore]`. Put it on maps, chart
  containers, horizontal scroll rows and anything with its own gesture.
- Units are never capitalised by CSS. Word states are sentence-cased in code.
