# Component library — reusable scene partials

Small builder functions in `../assets/scene-kit.js` (copy the ones you need inline — the
deliverable is one self-contained `.html`). Each wraps a primitive from `diagram-animation`'s
recipe table (node appear, edge draw, flowing data, highlight/dim, count-up) with the dark-neon
look from `design-tokens.md`. All take a `<svg>` root and return the created element(s).

| Component | Function | Reel vocabulary | Underlying primitive |
|---|---|---|---|
| Node — mint funnel | `createFunnel(svg, {x,y,w,h})` | where a token/packet is spawned | static monoline shape |
| Node — terminal panel | `createPanel(svg, {x,y,w,h,label,accent,lines})` | CLIENT / SERVER / any actor | node appear + fake-line highlight |
| Edge — flow particle | `createPacket(...)` + `travel(tl, packet, {from,to,duration,at})` | traveling token / cookie / packet | flowing data (`offset-path` equivalent via tween) |
| Label — content morph | `morphPacket(tl, packet, {label,color}, at)` | tamper: `role:user` → `role:admin` | content morph (text + color) |
| Badge — verify ok | `badgeCheck(svg, {x,y})` | green check pop-in | badge pop-in, `back.out` ease |
| Badge — verify fail | `badgeHacker(svg, {x,y})` | red HACKER hexagon pop-in | badge pop-in |
| Affordance — verify | `magnifier(svg, {x,y})` | magnifying glass beat before a badge | opacity pop |
| Highlight-step | `dimOthers(tl, svg, activeId, at)` | focus the active panel, dim the rest | highlight/dim |
| Counter | `countUp(el, to, dur)` | "DB queries" counting up | rAF easeOutCubic count-up |
| Bonus node — layer stack | `layerStack(svg, {x,y,w,layers})` | Caching Layers: client→cache→redis→db | stacked node appear |
| Bonus node — session grid | `sessionGrid(svg, {x,y,cols,rows})` | Cookies: SESSION STORE grid, a cell lights up | grid + highlight |

## Usage pattern

```js
const svg = document.getElementById('stage');
defineGlow(svg);                       // once per scene, before any badge
createChrome(document.querySelector('.er-stage'), {
  handle: 'your_handle', title: 'JWT', footer: 'STATELESS · NO SESSION STORE',
});

const client = createPanel(svg, { x: 40, y: 230, w: 150, h: 100, label: 'CLIENT', accent: 'var(--er-client)' });
const server = createPanel(svg, { x: 210, y: 230, w: 150, h: 100, label: 'SERVER', accent: 'var(--er-server)' });
const packet = createPacket(svg, { x: 200, y: 80, label: 'role:user', sublabel: 'exp:2h' });

const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });
travel(tl, packet, { from: { x: 200, y: 80 }, to: { x: 115, y: 210 }, duration: 1.2, at: 0.8 });
dimOthers(tl, svg, 'CLIENT', 0.8);
// ... verify, morph, badge beats — see ../examples/jwt-reel.html for a full worked timeline
```

`../examples/jwt-reel.html` is the fully-inlined, working reference — copy its `<script>` block as
a starting point rather than assembling from scratch; it already wires the `?t=N` seek harness,
`prefers-reduced-motion` handling, and the `window.__ready` signal the verify scripts wait on.

## Scene/beat input (optional structured authoring)

For free-form use, describe the scene as prose and let the agent choreograph it directly in the
HTML/JS (as `jwt-reel.html` does). For repeatable/parameterized scenes, the same shape can be
expressed as data first and then compiled to the builder calls above:

```yaml
title: "JWT"
theme: dark-neon
nodes:
  - { id: mint,   label: "MINT",   shape: funnel }
  - { id: client, label: "CLIENT", accent: yellow }
  - { id: server, label: "SERVER", accent: magenta }
edges:
  - { from: mint,   to: client }
  - { from: client, to: server }
packet: { label: "role:user · exp:2h", style: ticket }
scenes:
  - { t: 0.0, caption: "Server mints a JWT",     spawn: packet, at: mint }
  - { t: 2.0, caption: "Sent to the client",     move: { packet, along: mint→client } }
  - { t: 4.0, caption: "Client calls the API",   move: { packet, along: client→server } }
  - { t: 6.0, caption: "Signature verified",     verify: server, badge: ok }
  - { t: 8.0, caption: "Attacker tampers role",  morph: { packet, to: "role:admin", color: danger } }
  - { t: 10.0, caption: "Verification fails",    badge: { node: server, kind: hacker } }
```

This isn't a build-required schema (there's no compiler shipped here) — it's a documented shape
for structuring a brief before authoring the HTML directly, matching
`docs/specs/2026-07-23-animated-system-graph-skill.md` §"Input format". Start from direct
HTML/JS authoring (as the golden example does); only formalize a real YAML→scene compiler if you
find yourself hand-writing the same choreography repeatedly.
