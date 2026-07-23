/*
  explainer-reel scene-kit — reusable SVG component builders + a GSAP master-timeline helper.
  Reference library: copy the functions you need inline into a scene's single <script> block.
  Depends on GSAP (load from CDN in the scene HTML, matching diagram-animation's stack) and the
  `.er-*` classes from theme.css. See ../references/component-library.md for usage + a full example.

  Primitives map 1:1 onto the reel's shared vocabulary (spec §0):
    createPanel   -> CLIENT/SERVER terminal node
    createFunnel  -> "mint" node
    createPacket  -> the traveling token/cookie/packet (edge payload)
    travel        -> flow-particle: move a packet along an edge
    morphPacket   -> content morph (text + accent color)
    badgeCheck / badgeHacker -> pop-in state badges
    magnifier     -> verify affordance
    dimOthers     -> highlight-step (focus one element, dim the rest)
    countUp       -> rAF count-up (Caching Layers style)
    layerStack / sessionGrid -> bonus nodes for the Cookies / Caching Layers scenes
*/

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

/** Chrome: handle / title / footer above and below the SVG stage. Call once per scene. */
function createChrome(root, { handle, title, footer }) {
  root.insertAdjacentHTML('afterbegin', `
    <div class="er-handle">@${handle}</div>
    <div class="er-title">${title}</div>
    <hr class="er-title-rule">
  `);
  root.insertAdjacentHTML('beforeend', `<div class="er-footer">${footer}</div>`);
}

/** Standard glow filter — call once, then apply class="er-glow" to any accent element. */
function defineGlow(svg, blur = 4) {
  const defs = el('defs', {}, svg);
  const f = el('filter', { id: 'er-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
  el('feGaussianBlur', { stdDeviation: blur, result: 'blur' }, f);
  const merge = el('feMerge', {}, f);
  el('feMergeNode', { in: 'blur' }, merge);
  el('feMergeNode', { in: 'SourceGraphic' }, merge);
  return f;
}

/** The "mint" node — a thin V-funnel where a packet is spawned. */
function createFunnel(svg, { x, y, w = 44, h = 40 }) {
  return el('path', {
    class: 'er-mono',
    d: `M ${x - w / 2} ${y} L ${x} ${y + h} L ${x + w / 2} ${y}`,
  }, svg);
}

/** A terminal-style panel node (CLIENT / SERVER): header dots + title + N fake code lines. */
function createPanel(svg, { x, y, w = 150, h = 90, label, accent, lines = 4, activeLine = 0 }) {
  const g = el('g', { class: 'er-panel', 'data-id': label }, svg);
  el('rect', { class: 'er-panel-rect', x, y, width: w, height: h, stroke: accent }, g);
  el('circle', { class: 'er-panel-dot', cx: x + 12, cy: y + 14, r: 2, fill: accent }, g);
  el('circle', { class: 'er-panel-dot', cx: x + 20, cy: y + 14, r: 2, fill: accent }, g);
  el('circle', { class: 'er-panel-dot', cx: x + 28, cy: y + 14, r: 2, fill: accent }, g);
  el('text', { class: 'er-panel-title', x: x + 38, y: y + 18, fill: accent }, g).textContent = `>>> ${label}`;
  const lineH = (h - 30) / lines;
  for (let i = 0; i < lines; i++) {
    const ly = y + 30 + i * lineH + lineH / 2;
    el('line', { class: 'er-panel-line', x1: x + 12, y1: ly, x2: x + w - 24, y2: ly }, g);
    el('circle', {
      class: 'er-panel-dot', cx: x + w - 12, cy: ly, r: 2.5,
      fill: i === activeLine ? accent : 'var(--er-line-dim)',
    }, g);
  }
  return g;
}

/** The traveling packet: [icon cell | label cell | icon cell], a perforated-ticket pill. */
function createPacket(svg, { x, y, label, sublabel = '', accent = 'var(--er-line)' }) {
  const g = el('g', { class: 'er-packet', transform: `translate(${x},${y})` }, svg);
  el('rect', { class: 'er-pill-rect', x: -14, y: -12, width: 28, height: 24, stroke: accent }, g);
  for (const dy of [-6, 0, 6]) el('circle', { cx: -14, cy: dy, r: 1.2, fill: accent }, g);
  const body = el('rect', { class: 'er-pill-rect', x: 16, y: -12, width: 64, height: 24, stroke: accent }, g);
  const text = el('text', {
    class: 'er-pill-text', x: 48, y: sublabel ? -1 : 4, 'text-anchor': 'middle', fill: accent,
  }, g);
  text.textContent = label;
  let subEl = null;
  if (sublabel) {
    subEl = el('text', {
      class: 'er-pill-text', x: 48, y: 9, 'text-anchor': 'middle', fill: 'var(--er-line-dim)',
      style: 'font-size:6px',
    }, g);
    subEl.textContent = sublabel;
  }
  el('rect', { class: 'er-pill-rect', x: 84, y: -12, width: 20, height: 24, stroke: accent }, g);
  for (let i = 0; i < 4; i++) {
    el('rect', {
      x: 88 + i * 4, y: 2 - i * 2, width: 2, height: 6 + i * 2, fill: accent,
    }, g);
  }
  return { group: g, body, text, subEl };
}

/** Move a packet group along a straight edge (from -> to), added to the master timeline `tl`. */
function travel(tl, packet, { from, to, duration = 2, at }) {
  tl.fromTo(packet.group, { x: from.x, y: from.y }, {
    x: to.x, y: to.y, duration, ease: 'power1.inOut',
  }, at);
}

/** Morph a packet's label/sublabel text + accent color (content morph). */
function morphPacket(tl, packet, { label, sublabel, color }, at) {
  tl.call(() => {
    packet.text.textContent = label;
    if (sublabel && packet.subEl) packet.subEl.textContent = sublabel;
    packet.body.setAttribute('stroke', color);
    packet.text.setAttribute('fill', color);
  }, null, at);
}

/** Verify affordance: a small magnifying-glass glyph pinned near a node. */
function magnifier(svg, { x, y }) {
  const g = el('g', { class: 'er-magnifier', transform: `translate(${x},${y})`, opacity: 0 }, svg);
  el('circle', { class: 'er-mono', cx: -2, cy: -2, r: 6 }, g);
  el('line', { class: 'er-mono', x1: 2, y1: 2, x2: 7, y2: 7 }, g);
  return g;
}

/** Green check badge pop-in (verified / ok). */
function badgeCheck(svg, { x, y }) {
  const g = el('g', {
    class: 'er-badge-check er-glow', transform: `translate(${x},${y}) scale(0.6)`, opacity: 0,
  }, svg);
  el('circle', { class: 'er-badge-hex', r: 9, stroke: 'var(--er-ok)' }, g);
  el('path', { d: 'M -4 0 L -1 4 L 5 -5', class: 'er-mono', stroke: 'var(--er-ok)', 'stroke-width': 2 }, g);
  return g;
}

/** Red HACKER hexagon badge pop-in (tamper detected / reject). */
function badgeHacker(svg, { x, y }) {
  const g = el('g', {
    class: 'er-badge-hacker er-glow', transform: `translate(${x},${y}) scale(0.6)`, opacity: 0,
  }, svg);
  const pts = [0, -12, 10, -6, 10, 6, 0, 12, -10, 6, -10, -6].reduce((s, v, i) =>
    s + (i % 2 === 0 ? `${v},` : `${v} `), '');
  el('polygon', { points: pts, class: 'er-badge-hex', stroke: 'var(--er-danger)' }, g);
  el('circle', { r: 6, class: 'er-badge-hex', stroke: 'var(--er-danger)' }, g);
  el('line', { x1: -4, y1: -4, x2: 4, y2: 4, stroke: 'var(--er-danger)', 'stroke-width': 1.5 }, g);
  el('text', {
    class: 'er-badge-label', x: 0, y: 24, 'text-anchor': 'middle', fill: 'var(--er-danger)',
  }, g).textContent = 'HACKER';
  return g;
}

/** Highlight-step: fade every `.er-panel` except the active one (focus + context). */
function dimOthers(tl, svg, activeId, at) {
  tl.to(svg.querySelectorAll(`.er-panel:not([data-id="${activeId}"])`), { opacity: 0.35, duration: 0.3 }, at)
    .to(svg.querySelector(`.er-panel[data-id="${activeId}"]`), { opacity: 1, duration: 0.3 }, at);
}

/** rAF-driven count-up for a <text> element (Caching Layers "DB queries" style counter). */
function countUp(el, to, dur = 1200) {
  const t0 = performance.now();
  (function tick(now) {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(to * e);
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}

/** Bonus node: vertical layer stack (Caching Layers scene) — client / cache / redis / db. */
function layerStack(svg, { x, y, w = 140, layers }) {
  const g = el('g', { class: 'er-layer-stack' }, svg);
  layers.forEach((layer, i) => {
    const ly = y + i * 56;
    el('rect', { class: 'er-panel-rect', x, y: ly, width: w, height: 40, stroke: layer.accent }, g);
    el('text', { class: 'er-panel-title', x: x + 10, y: ly + 24, fill: layer.accent }, g).textContent = layer.label;
  });
  return g;
}

/** Bonus node: session-store grid (Cookies scene) — a cell lights up green when a session lands. */
function sessionGrid(svg, { x, y, cols = 5, rows = 2, cell = 18, gap = 4 }) {
  const g = el('g', { class: 'er-session-grid' }, svg);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(el('rect', {
        class: 'er-mono', x: x + c * (cell + gap), y: y + r * (cell + gap), width: cell, height: cell, rx: 2,
      }, g));
    }
  }
  return { group: g, cells };
}
