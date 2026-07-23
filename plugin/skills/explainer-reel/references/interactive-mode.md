# mode=interactive — swimlane band system-flow diagrams

An alternate output mode: a self-contained, **interactive** HTML page (click nodes for detail,
switch tabs between flow variants, an "Animate flow" scrub button) instead of a looping GIF. Use
this when the user wants to *explore* a system flow, not just watch it loop — e.g. "map who calls
whom across these three services" rather than "make a 12-second explainer GIF."

## Compose with `visual-explainer`, don't rebuild it

This preset **wraps `visual-explainer`** (its `generate-web-diagram` command already produces
self-contained interactive HTML diagrams; the exemplar this preset generalizes —
`~/.agent/diagrams/oneplan-billing-flows-interactive.html` — was itself a `visual-explainer`
output). explainer-reel's job in `mode=interactive` is narrower than in `mode=reel`: supply the
**swimlane layout/motion grammar** as a named, reusable preset so `visual-explainer` doesn't have
to invent a bands+particles system-flow layout from scratch each time. It does not add its own
render pipeline for this mode — the deliverable *is* the interactive HTML, viewed in a browser.

**How to invoke:** ask `visual-explainer`'s `generate-web-diagram` for the requested system/flow,
and hand it `../assets/swimlane-preset.html` as the layout/motion reference — "build this diagram
using the swimlane preset: horizontal bands = systems, nodes carry the schema below, edges are
timed hops with flow-particles." Adapt the preset's CSS/JS in place (copy it, then replace
`BANDS`/`FLOWS`) rather than re-deriving the mechanism from `visual-explainer`'s general
guidance — the preset already encodes the IBM Plex dev-console theme and the four moving parts
below correctly.

## The four moving parts

1. **Bands** — one horizontal swimlane per system (`BANDS` array: `id`, `label`, `ic` (icon),
   `col` (accent)). A node's `sys` field places it in a band (CSS grid row). An edge whose two
   nodes sit in different bands *is* a network hop — that's the "arrow that jumps a band" grammar
   the addendum calls for; nothing else marks a hop explicitly, the band gap does.
2. **Nodes** — `n(sys, lane, col, title, subtitle, extras)`. `lane`/`col` control lane accent
   color (the left border stripe + connected edge/particle color) and column placement
   (time-order, left→right). `extras`: `id` (required, referenced by edges), `detail` (shown in
   the click panel), `path` (an API route chip), `writes` (a green "what got written" line),
   `flag` (a red callout — pulses the node), `badge` (`[class, text]`), `ok` (green "ok" badge),
   `svc` (a small service-name chip).
3. **Edges + flow-particles** — `[from, to, style, label]`. `style` keys into `LANECOL` (reuse the
   node's lane color, or `crit`/`shared`/`store`/`db`) and drives a dashed stroke for `crit`. Each
   edge gets a bezier `<path>` plus small dots animated along it via CSS
   `offset-path`/`offset-distance` (`@keyframes flow`) — a continuous, ambient version of the
   reel's `travel()` primitive, always-on rather than timeline-scrubbed.
4. **Tabs + detail panel + "Animate flow"** — `FLOWS` maps a tab id to one or more named variants
   (e.g. two providers, two platforms) via `plat: true` + a `platseg` toggle; omit `plat` for a
   single variant. Clicking a node highlights it, dims unconnected nodes, and fills the `#detail`
   panel from that node's fields. "Animate flow" walks nodes in topological order (BFS from
   sources) via `stepIndex`, one `select()` per beat.

## Accessibility

`@media (prefers-reduced-motion: reduce)` hides the flow-particles and stops the node `pulse`
animation — structure and click/detail interactivity stay fully usable either way.

## What NOT to do

- Don't port your own topic's confidential data into a shared/portable copy of this preset —
  genericize node text the same way `swimlane-preset.html`'s checkout example does.
- Don't reach for `mode=reel`'s GIF pipeline here — an interactive page has no fixed "frame" to
  freeze into a loop; if the user explicitly wants a static preview image too, a single
  `playwright screenshot` of the default tab/variant is enough (no palettegen GIF needed).
- Don't hand-roll a new bands/particles mechanism inside `visual-explainer`'s general CSS-pattern
  guidance — that's exactly the duplication this preset exists to avoid.
