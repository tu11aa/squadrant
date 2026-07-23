---
name: explainer-reel
description: This skill should be used when the user asks to "animate a system diagram", "make a reel explaining X", "turn this architecture into a GIF", "explain this flow with motion", "make a JWT/auth/cache-style animated explainer", "map who calls whom across these systems", "make an interactive system-flow diagram with bands/swimlanes", or wants either a short looping GIF (dark-neon, monoline, terminal-panel style) or a clickable interactive HTML diagram that explains a structure, system, or flow — for embedding in or alongside HTML/markdown docs. Covers self-contained HTML scene authoring, a dark-neon component library, an HTML→Playwright→FFmpeg GIF pipeline, and a swimlane-band interactive preset that composes with `visual-explainer`. Optional MP4 export via Remotion.
version: 0.2.0
---

# explainer-reel

Two output modes for explaining a structure/system/flow with motion or interactivity, instead of
a static diagram:

| Mode | Output | Use when |
|---|---|---|
| **`reel`** (default) | a short, looping animated **GIF** — dark-neon, thin monoline, terminal-panel chrome | the ask is a passive, embeddable loop (e.g. "how JWT auth works" as a `<img>` in docs) |
| **`interactive`** | a self-contained **interactive HTML** page — dark IBM Plex dev-console theme, horizontal system bands, click-node detail panel, tabs | the ask is to *explore* who-calls-whom across systems (e.g. "map this request across three services") |

Both modes are **wrap-the-engine, build-the-style-pack** — see provenance below. Pick the mode
from the user's ask; default to `reel` when the request is ambiguous (issue #598's original scope
and golden reference are `reel` mode).

**Provenance:**
- `mode=reel` *wraps* `iart-ai/explainer-video-skills` (the engine — motion primitives + a
  verify-loop toolkit) with a squadrant style-pack (design tokens + component library + a GIF
  pipeline the engine doesn't ship).
- `mode=interactive` *wraps* `visual-explainer`'s `generate-web-diagram` (the engine for
  self-contained interactive HTML) with a named **swimlane preset** (bands/particles/detail-panel
  layout grammar) so that command doesn't reinvent the layout each time.

See `docs/specs/2026-07-23-animated-system-graph-skill.md` (issue #598, addendum for the two-mode
scope) for the full build-vs-buy rationale. Don't rebuild either engine's techniques from
scratch — reuse them; this skill only supplies the style/preset layer on top.

## When to use this vs. plain `visual-explainer`

- Plain `visual-explainer` — static or entrance-only diagrams (one-shot reveal on load), or an
  interactive diagram with no particular bands/swimlane shape. Use for most architecture docs,
  plans, and diagrams.
- `explainer-reel` `mode=reel` — **continuous, looping motion** is the explicit ask: a packet
  traveling a path, a counter climbing, a verify/reject beat.
- `explainer-reel` `mode=interactive` — the ask specifically wants **bands = systems** with
  network-hop edges and flow-particles (a "swimlane" system-flow map), not a general diagram.

## Mode: `reel` (default)

### Prerequisites

1. **The engine.** If `diagram-animation`'s recipe table isn't already available in this session,
   install it once per project:
   ```bash
   npx skills add iart-ai/explainer-video-skills -a claude-code -s diagram-animation -y
   ```
   This gives you the motion-primitive reference (`references/diagram-and-chart-recipes.md`) for
   node/edge reveals, `offset-path` traveling dots, `stroke-dashoffset` edge-draw, and rAF
   count-ups. This skill's own `assets/scene-kit.js` already implements the specific components you
   need for the dark-neon look — read the engine's recipes when you need a primitive `scene-kit.js`
   doesn't cover yet, rather than inventing new CSS/JS from scratch.
2. **Tooling.** `npx` (Playwright auto-fetches Chromium on first use: `npx playwright install
   chromium`) and `ffmpeg`/`ffprobe` on PATH.

### The pipeline (zero-React default)

```
scene brief → self-contained .html (SVG + GSAP, dark-neon theme, ?t=N seek harness)
            → verify: scripts/seek-shot.sh + scripts/contact-sheet.sh (freeze/tile/eyeball)
            → scripts/render-gif.sh (Playwright frame capture → FFmpeg palettegen/paletteuse)
            → looping .gif
```

MP4 is optional and secondary — only reach for Remotion (the engine's Heavy tier) if the user
explicitly wants a social/video export; the GIF path has no React/build dependency.

### 1. Author the scene

Start from `examples/jwt-reel.html` — copy it, then swap the nodes/palette/beats for your topic.
It's a fully worked, self-contained example: theme tokens inlined, `scene-kit.js`-style builders
inlined, a GSAP master timeline, the `?t=N` seek harness, `prefers-reduced-motion` handling, and
the `window.__ready` signal the verify scripts wait on. Don't build a scene from a blank file —
adapt the working one.

- Design tokens (colors, fonts, stroke, glow): `references/design-tokens.md` /
  `assets/theme.css`.
- Component builders (panels, packets, badges, highlight-step, counters, layer stacks, session
  grids): `references/component-library.md` / `assets/scene-kit.js`.
- Keep the reel-vocabulary shape: nodes have a fixed accent color that never changes meaning,
  a traveling `packet` is the payload, `scenes`/beats are timed and captioned, everything loops.
- Honor `prefers-reduced-motion`: freeze to the final composed frame, no looping motion (see the
  example's harness code — this mirrors both the engine's and `visual-explainer`'s a11y rule).

### 2. Verify fidelity before rendering

```bash
scripts/seek-shot.sh your-scene.html 0 <mid> <end>
scripts/contact-sheet.sh /tmp/sheet.png frame-0.png frame-<mid>.png frame-<end>.png
```
Eyeball the contact sheet: reveal order correct, connectors land on the right nodes, no
clipped/off-canvas text, color grammar consistent, badges land on the intended frame.

### 3. Render the GIF

```bash
scripts/render-gif.sh your-scene.html <duration_s> <fps> out.gif [width] [viewport WxH]
# e.g.
scripts/render-gif.sh examples/jwt-reel.html 12 15 jwt-reel.gif 480 400,640
```
Pass `[viewport WxH]` matching your scene's stage pixel size for a tight crop (no black margin).
Cap width ~480–720px and fps ~15–20 to keep GIF size sane; the script already loops seamlessly
(`-loop 0`) and dithers (`paletteuse=dither=sierra2_4a`) so neon-on-black gradients don't band.

### 4. (Optional) MP4 export

Only if the user asks for a social/video export: build the scene as a Remotion composition per
`diagram-animation`'s Heavy tier, then assert it with the engine's `scripts/probe-mp4.sh`. Not
required for the GIF path — don't block on it.

### Output contract (`reel`)

- Primary: `<name>.gif` — looping, embed-friendly, drops into HTML/markdown.
- Always also produce: `<name>.html` — the self-contained authoring/preview scene (so it can be
  scrubbed and re-rendered later).
- Optional: `<name>.mp4` — only on explicit request.

### Golden reference (`reel`)

`examples/jwt-reel.html` reproduces the *style/technique* of a JWT auth-flow reel (mint → travel
client→server → verify badge → tamper → HACKER reject, "STATELESS · NO SESSION STORE" footer) —
the acceptance demo for this skill (issue #598). It's a technique reproduction, not a copy of any
specific creator's video: swap the placeholder `@your_handle` chrome for your own before
publishing, and don't reuse anyone's exact copy/branding.

## Mode: `interactive`

A self-contained, clickable HTML page: horizontal **bands = systems**, nodes placed in time order
within their band, edges that jump a band = a network hop (labeled), continuous flow-particles
along each edge (CSS `offset-path`), a click-node → detail panel, and tabs for switching between
flow variants. Full schema + composition instructions: `references/interactive-mode.md`.

1. **Don't build this from scratch or from `visual-explainer`'s general guidance alone.** Start
   from `assets/swimlane-preset.html` — copy it, then replace the `BANDS`/`FLOWS` data with your
   own systems/nodes/edges. It already has the working mechanism (bands, SVG edges + particles,
   detail panel, tabs, "Animate flow", `prefers-reduced-motion` handling).
2. Fill in nodes per `references/interactive-mode.md`'s schema (`sys`, `lane`, `col`, title,
   subtitle, and optional `detail`/`path`/`writes`/`flag`/`badge`/`ok`/`svc`).
3. Open the result in a browser (or `visual-explainer`'s render step) — no GIF/render pipeline
   needed; the interactive HTML *is* the deliverable.
4. If the user also wants a static preview image, one `playwright screenshot` of the default tab
   is enough — don't run the `reel` mode's GIF pipeline for this.

### Output contract (`interactive`)

- Primary: `<name>.html` — self-contained, interactive, opens directly in a browser.
- No GIF/MP4 by default (there's no single "frame" to loop); add a screenshot only if asked.

## Attribution

Dark-neon monoline reel style (`mode=reel`) decoded from `@duchminh_nguyen`'s reel series
(research handoff, `docs/specs/2026-07-23-animated-system-graph-skill.md` §0) — style/technique
reproduction only. Engine (`diagram-animation`, `seek-shot.sh`, `contact-sheet.sh`) from
`iart-ai/explainer-video-skills`, MIT license — see `scripts/README.md`. Swimlane preset
(`mode=interactive`) generalizes the bands/particles/detail-panel mechanism first produced by the
`visual-explainer` skill — see `references/interactive-mode.md`.
