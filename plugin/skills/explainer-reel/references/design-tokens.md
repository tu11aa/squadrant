# Design tokens — dark-neon monoline theme

Decoded from a consistent motion-graphics reel series by **`@duchminh_nguyen`** (frame-extracted
from downloaded copies for research — see `docs/specs/2026-07-23-animated-system-graph-skill.md`
§0, tracked in issue #598). This file documents the *style*; `iart-ai/explainer-video-skills`
(the wrapped engine) supplies the *motion technique*. Reproduce the look for your own content —
credit the original creator, don't reuse their exact copy/branding (title text, handle, footer
copy) verbatim.

Tokens live in `../assets/theme.css` as CSS custom properties. Copy that file's `<style>` block
inline into your scene — the deliverable is one self-contained `.html`, never an external
stylesheet reference.

## Surface

- Near-black background (`#060608`), not pure `#000` — a very subtle radial vignette
  (`--er-vignette`, dark maroon/purple center fading to the base black) gives depth without
  reading as colored.

## Palette — meaning is fixed, never remapped mid-piece

| Token | Hex | Meaning |
|---|---|---|
| `--er-client` | `#d9b843` (yellow) | client / requester panel + accents |
| `--er-server` | `#d454e0` (magenta) | server / authority panel + accents |
| `--er-ok` | `#3ddc84` (green) | verified / cache-hit / success |
| `--er-cache` | `#8b6bff` (purple) | cache / redis / storage tier |
| `--er-danger` | `#ff5a3c` (red-orange) | title, danger, tamper, counters, reject |
| `--er-line` | `#aeb4bd` | default monoline stroke (funnels, connectors, unaccented nodes) |
| `--er-line-dim` | `#4a4e56` | dimmed / inactive context (highlight-step "focus and dim") |

## Stroke

Thin **monoline** everywhere — `--er-stroke-w: 1.5`. No fills on structural shapes (funnels,
connectors, badge outlines); fills are reserved for panel backgrounds (`#0b0c10`, near-black) and
accent glyphs (bars, dots, checkmarks). A `feGaussianBlur` glow filter (`#er-glow`, ~4px) is
applied only to "live" accent moments — badge pop-ins, not idle chrome — to keep the glow meaning
"this just happened," not decoration.

## Typography

- **Title** — bold condensed, red-orange (`--er-font-title`: Barlow Condensed / Oswald / Arial
  Narrow fallback), ~34px, subtle text-shadow glow matching `--er-danger`. One or two words
  (`JWT`, `COOKIES`), centered top.
- **Handle** — small, wide letter-spacing, dim gray, directly above the title (`@your_handle` —
  swap for your own; see attribution note above).
- **Footer caption** — small mono, uppercase, wide letter-spacing, dim gray, bottom-center. One
  line summarizing the takeaway (e.g. `STATELESS · NO SESSION STORE`).
- **In-scene labels** (panel headers, packet text, badge labels) — monospace throughout
  (`--er-font-mono`: JetBrains Mono / IBM Plex Mono fallback) — reads as "system/terminal," not
  marketing copy.

## Panel chrome (terminal-style nodes)

A rounded rect (`rx: 6`), accent-colored stroke, near-black fill. Header row: three small accent
dots (not traffic-light colors — same accent as the panel) + `>>> LABEL` in the accent color.
Body: 3–4 thin horizontal "fake code lines" (rounded stroke, dimmed) each with a trailing dot —
the top line's dot is accent-colored ("active"), the rest are dimmed gray ("idle context"). This
is the same focus/dim grammar `diagram-animation` recommends, applied at the sub-node level.

## Aspect ratio

The reference reels are vertical 9:16 (360×640) for social. The user's actual use case is an
embedded GIF, so aspect is flexible — default to something embed-friendly (9:16, 1:1, or 16:9)
per scene, not a hard requirement. Cap final GIF width to ~480–720px (see
`../scripts/render-gif.sh`).

## Attribution

Style reproduced from `@duchminh_nguyen`'s reel series for the user's own explainer content. This
is a technique/style reproduction, not a copy of their specific videos, copy, or branding — swap
placeholder handles/titles for your own before publishing.
