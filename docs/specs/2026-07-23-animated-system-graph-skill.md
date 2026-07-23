# Spec: `animated-system-graph` skill — continuous, playable animated architecture diagrams

**Date:** 2026-07-23
**Author:** research side-session
**Status:** Proposed (scoping — no code) · tracked in **[#598](https://github.com/tu11aa/squadrant/issues/598)** · skill name chosen: **`explainer-reel`**
**Motivation:** User wants to produce *animated* system-description graphs / architecture diagrams
(motion-graphics style) like a referenced Facebook reel. The reel was **decoded from a downloaded
copy** (frame-extracted via ffmpeg) — see §0.

## 0. Reference reels — decoded

Source: `@duchminh_nguyen`, a **consistent motion-graphics series** of ~15–22s **vertical 9:16
(360×640)** concept explainers, near-black background, continuous loop. Three reels decoded (frames
extracted via ffmpeg):

- **"JWT"** (17.6s) — a token card (`role:user`·`exp:2h`, perforated-ticket pill) is minted from a
  V-funnel → travels to **CLIENT** panel (yellow) → across to **SERVER** panel (magenta) → magnifier
  verify → **green check**; final scene tampers it to `role:admin` (morphs red) + red **hexagon
  "HACKER"** badge → verify fails. Footer "STATELESS · NO SESSION STORE".
- **"Cookies"** (22.5s) — CLIENT↔SERVER, an envelope/cookie packet travels; a **SESSION STORE** grid
  under the server lights a **green cell** (server keeps state). Footer "COOKIE = THE TICKET · SERVER
  KEEPS THE STATE".
- **"Caching Layers"** (14.4s) — vertical stack CLIENT → CLIENT CACHE → REDIS → DATABASE; **particle
  dots fall** through the layers; a **"DB queries" counter counts up 0→2→4→6** (red); then cache
  layers **fill** (green/purple bars) and later requests hit cache, so the DB counter stalls at 6.

**Shared design system** (this is what a style-pack must encode):
- 9:16, near-black bg; bold red-orange condensed **title** + `@handle` top, mono **footer caption**.
- Thin **monoline + neon** palette: yellow=client, magenta=server, green=ok/hit, purple=redis,
  red=danger/counter. Terminal-style panel chrome (fake code lines + colored dots).

**Shared animation primitives** (all covered by `diagram-animation`'s recipe table — see §2/§3):
packet/particle **traveling along a path**, particle **streams**, **count-up** numbers,
**progress/fill bars** on layers, node **state highlight/glow**, **badge pop-in** (check / hexagon),
content **morph** (text + color), timed **beat/scene** reveal with captions. Loops.

**Format implication + user's actual use case:** although the references are social video reels, the
user's use case is **embedding an animated GIF into HTML/markdown explainers** — to explain a
*structure / system / flow*, often **combined with other skills** (e.g. `visual-explainer` diagrams).
So the **primary output is a GIF** (portable, self-contained, drops into any `<img>`/markdown, no video
player), not MP4. Aspect ratio is flexible (16:9 or 1:1 embed-friendly, not necessarily 9:16). HTML
remains the authoring/preview layer; MP4 is a secondary/optional export for social.

---

## 1. Gap analysis — do existing skills already do this?

**No.** The installed visual toolkit produces *static or entrance-only* output. Concretely:

| Skill | What it does | Animated? | Gap |
|---|---|---|---|
| `visual-explainer` (generate-web-diagram / generate-slides / architecture) | Self-contained HTML diagrams via Mermaid + CSS Grid + Chart.js. Ships **anime.js** + CSS `@keyframes` (`fadeUp`, `drawIn`, `countUp`, stagger). | **Entrance-only.** One-shot reveal on load. | SKILL.md line 73 *explicitly forbids* continuous motion: "Do not use continuous glow, pulse, or breathing effects on static content." No looping data-flow, no play/pause/scrub/timeline controls. |
| `dataviz` | Charts/plots/dashboards of *data* (matplotlib, plotly, d3, Recharts). | Static. | Visualizes datasets, not *system architecture*; no motion, no graph-topology animation. |

**Conclusion:** genuine capability gap. `visual-explainer` has the *ingredients* (anime.js, SVG,
self-contained-HTML ethos) but is philosophically anti-continuous-motion and has no playback UI.

## 2. Ecosystem scan (`npx skills find`)

Relevant installable skills exist, but all are **low-install third-party** (find-skills quality bar:
prefer 1K+ installs, be cautious < 100):

| Skill | Installs | Output | Notes |
|---|---:|---|---|
| `zc277584121/marketing-skills@mermaid-to-gif` | 2.4K | **GIF** | Mermaid → animated GIF via **Playwright + Chromium + FFmpeg** (Python). Healthiest install count. Good *export recipe* to borrow. |
| `iart-ai/explainer-video-skills@diagram-animation` | 135 | (unspecified) | "Progressive disclosure": reveal nodes → edges → labels, dim/highlight steps held 0.5–1.5s. Good *choreography model* to borrow. |
| `cclank/lanshu-animated-architecture-diagram` | 39 | `.excalidraw` + `.png` + **`.gif`** | Hand-drawn dark aesthetic; "moving glow points + pulsing module highlights" — closest to the referenced style. Bundled renderer. |
| `supermemoryai/skills@svg-animations` | 1.5K | SVG | General SVG animation, not system-graph-specific. |
| `rohitg00/manim-video-generator@motion-graphics` | 54 | Manim video | Python/Manim — heavy render pipeline, not self-contained HTML. |

### Deep inspection (cloned + read the source, not just skills.sh)

- **`iart-ai/explainer-video-skills`** — a 5-skill suite (`explainer-video`, `diagram-animation`,
  `whiteboard-animation`, `isometric-animation`, `wrapped-video`), cross-agent (Claude/Cursor/Codex/
  40+). `diagram-animation`'s recipe table covers **every primitive** in §0: node appear, edge draw
  (`stroke-dashoffset`), **flowing data = traveling dot via `offset-path`**, bar grow, line draw,
  **count-up (rAF easeOutCubic)**, highlight/dim. Ships a real **verify-loop toolkit** in `scripts/`:
  `seek-shot.sh` (Playwright screenshots a standalone HTML `?t=N` seek harness), `contact-sheet.sh`
  (ffmpeg tile), `probe-mp4.sh` (ffprobe assert). **Two tiers: Light = self-contained HTML seek
  harness; Heavy = Remotion/Manim → real MP4.** This is exactly the architecture §3 was going to
  hand-build. **Gap:** it's a *technique* skill — it does NOT encode `@duchminh_nguyen`'s specific
  look (neon-monoline-on-black, terminal panels, title/handle/footer, JWT/Cookies/Caching templates).
- **`zc277584121/marketing-skills@mermaid-to-gif`** — Playwright+Chromium+FFmpeg, Mermaid→GIF only.
  No traveling packets / count-ups / morphs. Good only as an export-recipe reference; `iart-ai`
  already ships a better one.
- **`cclank/lanshu-animated-architecture-diagram`** — a fixed Python renderer → Excalidraw+PNG+GIF,
  hand-drawn aesthetic. Wrong look, less flexible. Not a fit.

**Conclusion:** the reusable machinery (motion recipes + render/verify pipeline, cross-agent) already
exists and is well-built in `iart-ai/explainer-video-skills`. The *only* thing missing for these
reels is the branded **style layer + scene templates**. So: don't rebuild the engine, and don't ship
theirs raw — **wrap it**.

## 3. Recommendation — WRAP `iart-ai/explainer-video-skills` with a squadrant style-pack

Build-vs-buy verdict: **buy the engine, build the style.**

- **Engine (reuse, don't rebuild):** install `iart-ai/explainer-video-skills`. Its `diagram-animation`
  provides the motion primitives; its `scripts/` provides the seek→contact-sheet→probe verify loop;
  `explainer-video` adds script/pacing/caption structure; Remotion (Heavy tier) does the 9:16 MP4.
- **Style-pack (build — the thin new part):** a small squadrant skill `duchminh-reels` (working name)
  that depends on / invokes `diagram-animation` and adds:
  1. **Design tokens** — dark-neon theme: black bg, palette (yellow/magenta/green/purple/red), mono
     fonts, monoline stroke weights, title/handle/footer chrome.
  2. **Scene component library** (HTML/SVG partials) — CLIENT & SERVER terminal panels, SESSION STORE
     grid, layer stack (client→cache→redis→db), traveling ticket/cookie/packet, verify magnifier,
     green-check badge, red HACKER hexagon, count-up counter.
  3. **A golden reference** — reproduce the JWT reel first to prove parity with §0, then generalize.
  4. Authoring on the **Light tier** (`?t=N` HTML + `seek-shot.sh`), final render on **Heavy tier**
     (Remotion → 9:16 MP4).

This keeps `visual-explainer`'s "no continuous motion" rule intact (motion is an explicit opt-in in a
separate skill), reuses a battle-tested cross-agent engine (fits the multi-agent direction), and
scopes the new work down to a style-pack + templates instead of an animation framework.

**Trial-first (recommended before committing):** `npx skills add iart-ai/explainer-video-skills -g -y`,
then ask it to "animate the JWT auth flow as a 9:16 reel — token travels client→server, verify badge,
then tamper→hacker reject." Judge how close the raw engine gets to §0; the style-pack fills the gap.

### Tech stack (following the engine's two tiers)

The style-pack inherits the engine's stack; it only adds theme tokens + scene partials on top.

| Concern | Choice | Why |
|---|---|---|
| Output (primary) | **GIF** (looping, embed-friendly aspect) | Drops into HTML/markdown as a plain `<img>`; combines with `visual-explainer` and other skills; no video player. |
| Authoring / preview (Light tier) | **Self-contained `.html`** scene with a `?t=N` **seek harness** | Engine's Light tier; zero-build, scrub/iterate, portable to any agent. Matches user's self-contained-HTML preference. |
| Graph render | Inline **SVG** nodes/edges | Edges become real `<path>` geometry the traveling packet follows via `offset-path`. |
| Motion (Light) | **GSAP timeline + CSS** — `offset-path` traveling dot, `stroke-dashoffset` edge-draw, `@keyframes` glow, rAF count-up | Exactly `diagram-animation`'s recipe table; no bespoke framework. |
| GIF render | `seek-shot.sh` (Playwright) captures each frame → **FFmpeg `palettegen`/`paletteuse`** → high-quality looping GIF | Zero React toolchain; deterministic; the engine already ships the Playwright seek harness. |
| Verify loop | `contact-sheet.sh` (ffmpeg tile of start\|mid\|end) → eyeball vs §0 | Ships with the engine; same technique used to decode the reels here. |
| Optional MP4 (Heavy) | **Remotion** → deterministic MP4 for social, asserted by `probe-mp4.sh` | Engine's Heavy tier; only if the user later wants a polished social video. Not needed for the GIF path. |
| Accessibility (HTML preview) | Honor `prefers-reduced-motion` (freeze to final frame) | Engine + visual-explainer both enforce it. |

**Pipeline is now zero-React by default:** HTML scene → Playwright frame capture → FFmpeg GIF. This is
the `mermaid-to-gif` recipe, and it keeps the whole thing self-contained and combinable with other
squadrant skills. Remotion/MP4 stays an optional add-on, not a dependency. **Rejected:** Manim (heavy,
wrong aesthetic), Framer Motion (React runtime with no benefit for GIF output).

### GIF quality / size notes (it's the primary output, so budget for it)

- Use FFmpeg two-pass `palettegen` + `paletteuse` (dithering) — plain GIF export bands badly on the
  neon-on-black gradients.
- Cap dimensions for embed (e.g. ~480–720px wide) and framerate (~15–20fps) to keep file size sane;
  loop seamlessly (first frame == resting state).
- Offer a `--mp4` opt-out for cases where GIF size is too large (long/complex scenes).

### Input format

Graph + a **scene/beat script** (the reel is scene-driven, not just auto-choreographed). A traveling
`packet` is a first-class primitive; nodes carry an accent color; a packet can `morph` and `badge`:

```yaml
title: "JWT"
aspect: "9:16"          # 9:16 reel default | 16:9 | 1:1
loop: true
theme: dark-neon        # monoline + neon accents on black
nodes:
  - { id: mint,   label: "MINT",   shape: funnel }
  - { id: client, label: "CLIENT", accent: yellow }
  - { id: server, label: "SERVER", accent: magenta }
edges:
  - { from: mint,   to: client }
  - { from: client, to: server }
packet:                 # the traveling token card
  label: "role:user · exp:2h"
  style: ticket
scenes:                 # timed beats with captions
  - { t: 0.0, caption: "Server mints a JWT",     spawn: packet, at: mint }
  - { t: 2.0, caption: "Sent to the client",     move: { packet, along: mint→client } }
  - { t: 4.0, caption: "Client calls the API",   move: { packet, along: client→server } }
  - { t: 6.0, caption: "Signature verified",     verify: server, badge: ok }
  - { t: 8.0, caption: "Attacker tampers role",  morph: { packet, to: "role:admin", color: danger } }
  - { t: 10.0, caption: "Verification fails",    badge: { node: server, kind: hacker } }
```

Free-text article/spec input also accepted (extract actors/stages/flows, like lanshu/diagram-animation).

### Output

- Primary: `<name>.gif` — looping, embed-friendly, drops into HTML/markdown explainers alongside
  other skills (e.g. `visual-explainer`).
- Also: `<name>.html` — the self-contained authoring/preview scene (scrub before rendering).
- Optional: `<name>.mp4` via `--mp4` — for social or when GIF size is too large.

## 4. Scope / placement

- New skill dir `plugin/skills/animated-system-graph/` (portable markdown per multi-agent direction),
  OR a new command inside the `visual-explainer` family if we prefer to keep motion under one roof.
  **Recommend a sibling skill** — keeps visual-explainer's "no continuous motion" rule intact and
  makes the animated variant an explicit opt-in.
- Reuse visual-explainer's palette, fonts, dark-mode, and `diagram-shell` container patterns.
- Follow Karpathy principles: ship the HTML+playback core first; GIF/MP4 export as a follow-up slice.

## 5. Open questions for the user

Style is known (§0) and the engine is chosen (§3). Remaining decisions:

1. **Approve build-vs-buy?** — install `iart-ai/explainer-video-skills` as the engine + build a thin
   squadrant style-pack on top (recommended), vs. build everything native, vs. use the engine raw
   without a style-pack.
2. **Render tier** — default is Light-tier HTML + `seek-shot.sh` + FFmpeg → **GIF** (zero React,
   embed-friendly). Do you also want the optional Remotion→MP4 add-on for social, or GIF only? See §3.
3. **Style-pack home** — a squadrant `plugin/skills/` skill (portable, fits multi-agent direction),
   or keep it as a personal skill outside the repo since these are `@duchminh_nguyen`-branded reels?
4. **Trial-first?** — `npx skills add iart-ai/explainer-video-skills -g -y`, reproduce the JWT reel,
   and judge the gap before scoping the style-pack. (Low risk, high signal — recommended.)

## 6. Recommended next action

**Trial the engine first (§5 Q4).** Install `iart-ai/explainer-video-skills`, ask it to build the JWT
reel as a 9:16 short, and compare to §0. Then dispatch a crew to build the `duchminh-reels` style-pack
(design tokens + scene component library from §3), using the JWT reel as the golden reference and the
engine's `seek-shot.sh`/`contact-sheet.sh` loop to verify parity frame-by-frame. Ship JWT parity
first, then Cookies + Caching, then generalize the scene schema (§4 input format).

## 7. Attribution

The reference reels are the creative work of **`@duchminh_nguyen`**. This spec reproduces a *visual
style/technique* for the user's own content; credit the original creator where appropriate (consistent
with the repo's "credit external inspirations" practice). Do not reuse their exact copy/branding.

## 8. Addendum (2026-07-23, mid-build) — second output mode: `mode=interactive`

While the `explainer-reel` skill was being built (crew `feat/598-explainer-reel`), the user added a
second required output mode, folded into the same skill rather than a separate one:

- **`mode=reel`** (default) — everything in §0–§7 above: the dark-neon monoline GIF, wrapping
  `iart-ai/explainer-video-skills`. Unchanged.
- **`mode=interactive`** — a self-contained **interactive** HTML "swimlane band system-flow"
  diagram: dark **IBM Plex** "dev-console" theme (distinct from `reel`'s neon-monoline theme);
  nodes grouped into horizontal **bands = systems**; an edge whose two nodes sit in different bands
  is a **network hop** (labeled); continuous **flow-particles** travel along SVG edges via CSS
  `offset-path`/`offset-distance` (an always-on cousin of `reel`'s timeline-scrubbed `travel()`);
  **click a node → detail panel**; **tabs** switch between flow variants.

**Reference exemplar to match:** `~/.agent/diagrams/oneplan-billing-flows-interactive.html`
(446 lines, vanilla HTML+SVG+CSS, no framework) — produced by the existing `visual-explainer`
skill's `generate-web-diagram` command from a general "dark dev-console" brief, not from a named
preset. Its bands/nodes/edges data is another project's real (and partly confidential) billing
logic and must **not** be copied into a portable squadrant skill — only the layout/CSS/JS
*mechanism* (bands, grid, edge+particle drawing, detail panel, tabs, `stepIndex` BFS ordering) is
reusable; example data must be genericized.

**Build-vs-buy verdict for this mode: compose with `visual-explainer`, don't rebuild it.** The
exemplar proves `visual-explainer` already produces exactly this kind of interactive HTML from
general guidance — there's no missing rendering engine here (unlike `mode=reel`, where
`iart-ai/explainer-video-skills` was a genuine capability gap `visual-explainer` doesn't cover:
its own SKILL.md forbids continuous motion). So `explainer-reel`'s job for `mode=interactive` is
narrower: package the swimlane mechanism as a **named, reusable preset** (`assets/
swimlane-preset.html` + `references/interactive-mode.md`) that `visual-explainer`'s
`generate-web-diagram` is handed as the layout/motion brief, instead of re-deriving a bands +
particles system-flow layout from scratch (or worse, from a second independent implementation)
every time someone asks for one. `explainer-reel` adds no new render pipeline for this mode — the
interactive HTML *is* the deliverable, viewed in a browser; no GIF/MP4 step applies.

**Acceptance for this mode:** a generic worked example (`assets/swimlane-preset.html`, a "checkout"
flow: browser → payment provider → order API → database, two tabs for card/wallet paths) proves
the mechanism renders correctly (bands, colored edges with labels + arrowheads, step numbers,
badges, flagged/pulsing "gotcha" nodes) — screenshotted and verified during the build. It is not
the "golden reference" acceptance demo (that's still the `reel`-mode JWT reel from §0); it's the
parity check for the *interactive* mechanism itself, since there's no single canonical reference
video for this mode the way there is for `reel`.

See `plugin/skills/explainer-reel/SKILL.md` ("Mode: `interactive`") and
`plugin/skills/explainer-reel/references/interactive-mode.md` for the shipped instructions.
