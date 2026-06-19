// src/dashboard/web-render.ts
//
// PURE render of a FullSnapshot to (a) a complete HTML document for the initial
// GET / load and (b) a per-tick JSON payload pushed over SSE. No I/O, no clock —
// every age is derived from snapshot-time deltas or `snap.generatedAt`, so the
// render is deterministic and unit-tested.
//
// Visual language: a glass-cockpit flight deck. A master-status ANNUNCIATOR and
// an inline-SVG health DONUT read the fleet at a glance; OVERVIEW / PROJECTS /
// DAEMON / ENVIRONMENT tabs (vanilla-JS, one SSE stream) hold the detail. Charts
// are inline SVG only (donut server-rendered; sparklines drawn client-side from a
// rolling history of successive SSE frames). Severity rolls UP (a `gone` bubbles a
// red rollup to its project header); the stale-build / link-lost banners render
// only when applicable; remediation is COPY-ABLE TEXT (never buttons — read-only
// beta). Zero new deps: vanilla JS + modern CSS + inline SVG.
import type { HealthState, ComponentHealth, DaemonSnapshot } from "@cockpit/core";
import { healCmdFor, ageText } from "@cockpit/core";
import type { FullSnapshot } from "./snapshot-merge.js";
import type { ExternalProbes, Probe, ProbeState } from "./probes.js";

type AnyState = HealthState | ProbeState;

const ICON: Record<AnyState, string> = { alive: "✔", stale: "•", gone: "✘", unknown: "○" };
// Rollup ordering: gone is worst, unknown never out-ranks a real degradation.
const SEV: Record<AnyState, number> = { alive: 0, unknown: 1, stale: 2, gone: 3 };
// Cockpit annunciator vernacular for each state.
const STATE_WORD: Record<AnyState, string> = { alive: "nominal", stale: "caution", gone: "fault", unknown: "unknown" };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function fmtAge(ms: number | null): string {
  return ms == null ? "—" : `${fmtDur(ms)} ago`;
}

function worst(states: AnyState[]): AnyState {
  let w: AnyState = "alive";
  for (const s of states) if (SEV[s] > SEV[w]) w = s;
  return w;
}

// ── Health tallies ────────────────────────────────────────────────────────────
interface Tally { alive: number; stale: number; gone: number; unknown: number; total: number }

function tally(states: AnyState[]): Tally {
  const t: Tally = { alive: 0, stale: 0, gone: 0, unknown: 0, total: states.length };
  for (const s of states) t[s]++;
  return t;
}

/** Master flight-status from an aggregate tally. gone → critical (red); stale →
 *  degraded (amber); else nominal (green). Log errors map to `stale`, never gone,
 *  so a noisy log can caution but never trips a CRITICAL master alarm. */
function masterClass(t: Tally): "ok" | "warn" | "crit" {
  if (t.gone > 0) return "crit";
  if (t.stale > 0) return "warn";
  return "ok";
}
const MASTER_WORD: Record<"ok" | "warn" | "crit", string> = { ok: "NOMINAL", warn: "DEGRADED", crit: "CRITICAL" };

// ── Small presentational atoms ──────────────────────────────────────────────────
function pill(state: AnyState, label: string): string {
  return `<span class="pill s-${state}"><span class="pdot"></span>${esc(label)}</span>`;
}

/** Status pill carrying the glyph + state word — used in component tables. */
function statePill(state: AnyState): string {
  return pill(state, `${ICON[state]} ${STATE_WORD[state]}`);
}

function banner(kind: "err" | "warn", text: string): string {
  return `<div class="banner ${kind}">${esc(text)}</div>`;
}

function remediation(text: string): string {
  // Copy-able text, NOT a button — read-only beta surface.
  return `<div class="rem">remediation <code>${esc(text)}</code></div>`;
}

function probeCell(label: string, p: Probe): string {
  const detail = p.detail ? ` · ${esc(p.detail)}` : "";
  return `${pill(p.state, label)}<span class="cell-detail">${detail}</span>`;
}

// ── Donut gauge (inline SVG) ────────────────────────────────────────────────────
const DONUT_ORDER: AnyState[] = ["alive", "stale", "gone", "unknown"];

/** The signature element: a four-segment health ring. Segment arc lengths are
 *  proportional to the tally; everything is plain SVG math so it is deterministic
 *  and testable. An empty tally shows a faint full track. */
function donut(t: Tally): string {
  const cx = 64, cy = 64, r = 52, w = 14;
  const C = 2 * Math.PI * r;
  let acc = 0;
  const segs = DONUT_ORDER.map((k) => {
    const v = t[k];
    if (v <= 0) return "";
    const len = t.total ? (v / t.total) * C : 0;
    const rot = t.total ? (acc / t.total) * 360 : 0;
    acc += v;
    return `<circle class="seg s-${k}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${w}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" transform="rotate(${(rot - 90).toFixed(2)} ${cx} ${cy})"></circle>`;
  }).join("");
  const track = `<circle class="donut-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${w}"></circle>`;
  return `<svg class="donut" viewBox="0 0 128 128" role="img" aria-label="fleet health distribution">${track}${segs}</svg>`;
}

function legendRow(state: AnyState, count: number): string {
  return `<div class="leg s-${state}"><span class="pdot"></span><span class="leg-n" data-countup="leg-${state}" data-value="${count}">${count}</span><span class="leg-l">${STATE_WORD[state]}</span></div>`;
}

/** A trend card: a label + a big readout value + an empty sparkline svg the
 *  client fills from rolling history (data-spark key). */
function trendCard(key: string, label: string, value: string, sub: string): string {
  return [
    `<div class="trend">`,
    `<div class="trend-head"><span class="trend-l">${esc(label)}</span><span class="trend-v">${esc(value)}</span></div>`,
    `<svg class="spark" data-spark="${key}" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"></svg>`,
    `<div class="trend-sub">${esc(sub)}</div>`,
    `</div>`,
  ].join("");
}

/** Sum delivery lag across projects whose captain is alive (online only).
 *  A captain that is offline with unread mail is not a live delivery problem. */
function liveDeliveryBehind(d: DaemonSnapshot): number {
  return d.tier2.projects.reduce((sum, p) => {
    const captain = d.tier1.find((c) => c.kind === "captain" && c.project === p.project);
    const captainState = captain?.state ?? "unknown";
    return captainState === "alive" ? sum + p.delivery.behind : sum;
  }, 0);
}

// ── Aggregate collection (pure) ─────────────────────────────────────────────────
interface Collected {
  now: number;
  daemonT: Tally; projT: Tally; envT: Tally; overall: Tally;
  errors: number; behind: number; crewAgeMs: number;
}

function collect(snap: FullSnapshot): Collected {
  const now = snap.generatedAt;
  const env = snap.external;
  const envStates: AnyState[] = [
    env.cmux.state,
    ...env.agentClis.map((c) => c.state),
    env.vaults.hub.state,
    ...env.vaults.spokes.map((s) => s.state),
    env.config.parseable.state,
    env.config.sessions.state,
    ...env.config.projectPaths.map((p) => p.state),
  ];
  const daemonStates: AnyState[] = [];
  const projStates: AnyState[] = [];
  let errors = 0, behind = 0, crewAgeMs = 0;
  if (snap.daemon !== "unreachable") {
    const t0 = snap.daemon.tier0;
    daemonStates.push("alive"); // the daemon process itself is up
    daemonStates.push(t0.build.state === "fresh" ? "alive" : "stale");
    daemonStates.push(t0.log.errorCount > 0 ? "stale" : "alive");
    errors = t0.log.errorCount;
    for (const c of snap.daemon.tier1) {
      projStates.push(c.state);
      if (c.kind === "crew" && c.lastSeenMs != null) crewAgeMs = Math.max(crewAgeMs, now - c.lastSeenMs);
    }
    for (const p of snap.daemon.tier2.projects) {
      if (p.delivery.behind > 0) projStates.push("stale");
      if (p.store.corruptCount > 0) projStates.push("gone");
    }
    behind = liveDeliveryBehind(snap.daemon);
  }
  return {
    now,
    daemonT: tally(daemonStates),
    projT: tally(projStates),
    envT: tally(envStates),
    overall: tally([...daemonStates, ...projStates, ...envStates]),
    errors, behind, crewAgeMs,
  };
}

// ── Tab: OVERVIEW ───────────────────────────────────────────────────────────────
/** A titled section header: a short heading + a one-line plain-language caption,
 *  so a first-time viewer knows what each block of widgets is showing. */
function sectionHead(title: string, sub: string): string {
  return `<div class="section-head"><h2 class="section-title">${esc(title)}</h2><p class="section-sub">${esc(sub)}</p></div>`;
}

function tierCard(name: string, t: Tally, desc: string): string {
  const w = t.total ? worst(([] as AnyState[]).concat(
    ...Array.from({ length: t.gone }, () => "gone" as AnyState),
    ...Array.from({ length: t.stale }, () => "stale" as AnyState),
    ...Array.from({ length: t.unknown }, () => "unknown" as AnyState),
    ...Array.from({ length: t.alive }, () => "alive" as AnyState),
  )) : "unknown";
  return [
    `<div class="tier-card">`,
    `<div class="tier-top"><span class="tier-name">${esc(name)}</span>${statePill(w)}</div>`,
    `<p class="tier-desc">${esc(desc)}</p>`,
    `<div class="tier-counts">`,
    `<span class="tc s-alive">${t.alive}<i>ok</i></span>`,
    `<span class="tc s-stale">${t.stale}<i>caution</i></span>`,
    `<span class="tc s-gone">${t.gone}<i>fault</i></span>`,
    `<span class="tc s-unknown">${t.unknown}<i>unknown</i></span>`,
    `</div></div>`,
  ].join("");
}

function renderOverview(snap: FullSnapshot, col: Collected): string {
  const linkLost = snap.daemon === "unreachable";
  const mc = linkLost ? "crit" : masterClass(col.overall);
  const word = linkLost ? "LINK LOST" : MASTER_WORD[mc];
  const out: string[] = [`<section class="panel" data-panel="overview" role="tabpanel" aria-label="Overview">`];

  out.push(sectionHead(
    "System Health",
    `${col.overall.alive} of ${col.overall.total} monitored components are alive — the ring shows the full breakdown by state.`,
  ));
  out.push(
    `<div class="hero a-${mc}">`,
    `<div class="gauge">`,
    donut(col.overall),
    `<div class="gauge-core"><span class="gauge-n" data-countup="monitored" data-value="${col.overall.total}">${col.overall.total}</span><span class="gauge-word">${esc(word)}</span><span class="gauge-cap">monitored</span></div>`,
    `</div>`,
    `<div class="legend">`,
    legendRow("alive", col.overall.alive),
    legendRow("stale", col.overall.stale),
    legendRow("gone", col.overall.gone),
    legendRow("unknown", col.overall.unknown),
    `</div>`,
    `</div>`,
  );

  out.push(sectionHead("Health by Tier", "How many components are healthy in each layer of the stack."));
  out.push(
    `<div class="tier-grid">`,
    tierCard("Daemon", col.daemonT, "cockpitd process, build freshness & log volume (Tier 0)"),
    tierCard("Projects", col.projT, "captains, crews & message data plane (Tier 1/2)"),
    tierCard("Environment", col.envT, "agent CLIs, vaults & config integrity (Tier 3/4)"),
    `</div>`,
  );

  out.push(sectionHead("Live Trends", "Magnitudes tracked over time — each sparkline builds as new updates arrive."));
  out.push(
    `<div class="trend-grid">`,
    trendCard("errors", "Daemon log", `${col.errors}`, "errors the daemon logged in the last window"),
    trendCard("behind", "Delivery lag", `${col.behind}`, "messages captains have not read yet"),
    trendCard("crewAge", "Crew heartbeat", linkLost ? "—" : fmtDur(col.crewAgeMs), "time since the quietest crew was last seen"),
    `</div>`,
  );

  out.push(`</section>`);
  return out.join("");
}

// ── Tab: PROJECTS ───────────────────────────────────────────────────────────────
function componentRow(c: ComponentHealth, now: number): string {
  const detail = c.detail ? esc(c.detail) : "";
  const row =
    `<tr>` +
    `<td>${statePill(c.state)}</td>` +
    `<td class="mono">${esc(c.kind)}</td>` +
    `<td class="mono">${esc(c.ref)}</td>` +
    `<td class="mono dim">${esc(ageText(c.lastSeenMs, now))}</td>` +
    `<td class="dim">${detail}</td>` +
    `</tr>`;
  const heal = healCmdFor(c);
  return heal ? row + `<tr class="rem-row"><td colspan="5">${remediation(heal)}</td></tr>` : row;
}

function deliveryBar(behind: number, maxSeq: number): string {
  const acked = Math.max(0, maxSeq - behind);
  const ackedPct = maxSeq > 0 ? (acked / maxSeq) * 100 : 100;
  const behindPct = maxSeq > 0 ? (behind / maxSeq) * 100 : 0;
  return [
    `<div class="dbar" role="img" aria-label="${acked} of ${maxSeq} delivered, ${behind} behind">`,
    `<span class="dbar-acked" style="width:${ackedPct.toFixed(1)}%"></span>`,
    `<span class="dbar-behind" style="width:${behindPct.toFixed(1)}%"></span>`,
    `</div>`,
  ].join("");
}

function renderProjects(snap: FullSnapshot, now: number): string {
  const out: string[] = [`<section class="panel" data-panel="projects" role="tabpanel" aria-label="Projects">`];
  out.push(sectionHead("Projects", "Per-project captains and crews, plus each project's mailbox delivery and task store."));
  if (snap.daemon === "unreachable") {
    out.push(`<div class="empty">Telemetry link lost — per-project data is served by the daemon. Start it to restore: <code>cockpit heal daemon</code></div></section>`);
    return out.join("");
  }
  const d = snap.daemon;
  const projects = new Set<string>([...d.tier1.map((c) => c.project), ...d.tier2.projects.map((p) => p.project)]);
  if (projects.size === 0) out.push(`<div class="empty">No projects registered yet.</div>`);
  for (const project of projects) {
    const comps = d.tier1.filter((c) => c.project === project);
    const dp = d.tier2.projects.find((p) => p.project === project);
    const rollupStates: AnyState[] = [
      ...comps.map((c) => c.state),
      dp && dp.delivery.behind > 0 ? "stale" : "alive",
      dp && dp.store.corruptCount > 0 ? "gone" : "alive",
    ];
    const rollup = worst(rollupStates);
    out.push(`<article class="card" data-rollup="${rollup}">`);
    out.push(`<header class="card-head"><span class="card-title">${esc(project)}</span>${statePill(rollup)}</header>`);
    if (comps.length) {
      out.push(
        `<table class="grid"><thead><tr><th>status</th><th>kind</th><th>ref</th><th>last seen</th><th>detail</th></tr></thead><tbody>`,
        ...comps.map((c) => componentRow(c, now)),
        `</tbody></table>`,
      );
    } else {
      out.push(`<div class="dim small">no live components reported</div>`);
    }
    if (dp) {
      const counts = Object.entries(dp.store.byState).map(([s, n]) => pill("unknown", `${n} ${s}`)).join("");
      out.push(
        `<div class="dp-grid">`,
        `<div class="dp-block"><span class="dp-l">mailbox</span><span class="dp-v"><span class="mono">${dp.mailbox.maxSeq}</span> entries · ${fmtBytes(dp.mailbox.sizeBytes)} · rotated ${dp.mailbox.rotationCount} · oldest ${fmtAge(dp.mailbox.oldestEntryAgeMs)}</span></div>`,
        `<div class="dp-block"><span class="dp-l">captain delivery</span>${deliveryBar(dp.delivery.behind, dp.mailbox.maxSeq)}<span class="dp-v"><span class="mono">${dp.delivery.behind}</span> behind</span></div>`,
        `<div class="dp-block"><span class="dp-l">task store</span><span class="chips">${counts || `<span class="dim small">no tasks</span>`}${dp.store.corruptCount > 0 ? pill("gone", `${dp.store.corruptCount} corrupt`) : ""}</span></div>`,
        `</div>`,
      );
    }
    out.push(`</article>`);
  }
  out.push(`</section>`);
  return out.join("");
}

// ── Tab: DAEMON ─────────────────────────────────────────────────────────────────
function instr(label: string, value: string, extra = ""): string {
  return `<div class="instr"><span class="instr-l">${esc(label)}</span><span class="instr-v">${value}</span>${extra}</div>`;
}

function renderDaemon(snap: FullSnapshot): string {
  const out: string[] = [`<section class="panel" data-panel="daemon" role="tabpanel" aria-label="Daemon">`];
  out.push(sectionHead("Daemon · Tier 0", "The cockpitd process at the root of everything — uptime, build freshness, sweep cadence, and log volume."));
  if (snap.daemon === "unreachable") {
    out.push(`<div class="empty">Daemon unreachable — no Tier 0 telemetry. ${remediation("cockpit heal daemon")}</div></section>`);
    return out.join("");
  }
  const t0 = snap.daemon.tier0;
  const buildState: HealthState = t0.build.state === "fresh" ? "alive" : "gone";
  // #fix(a): a fresh daemon that has not run a sweep yet is "awaiting first
  // sweep" — not "never swept". A null age means the loop simply hasn't ticked.
  const sweep = t0.sweep.ageMs == null
    ? "awaiting first sweep"
    : `last ${fmtAge(t0.sweep.ageMs)} · ${fmtDur(t0.sweep.cadenceMs)} cadence`;
  const sweepState: AnyState = t0.sweep.ageMs == null ? "unknown" : "alive";
  // #fix(b): present the log error count as a calm, non-alarming metric — a
  // caution at most, with a trend sparkline, never a red master alarm.
  const logState: AnyState = t0.log.errorCount > 0 ? "stale" : "alive";

  out.push(
    `<div class="instr-grid">`,
    instr("process", `<span class="mono">cockpitd</span> ${statePill("alive")}`, `<span class="instr-sub">pid ${t0.pid} · v${esc(t0.version)}</span>`),
    instr("uptime", `<span class="mono">${fmtDur(t0.uptimeMs)}</span>`),
    instr("build", `${pill(buildState, t0.build.state)}`, t0.build.state === "stale" ? remediation("npm run build && cockpit heal daemon") : ""),
    instr("sweep", `${pill(sweepState, sweep)}`),
    `</div>`,
  );

  out.push(
    `<div class="trend-grid">`,
    [
      `<div class="trend">`,
      `<div class="trend-head"><span class="trend-l">Log errors</span><span class="trend-v">${pill(logState, `${t0.log.errorCount}`)}</span></div>`,
      `<svg class="spark" data-spark="errors" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"></svg>`,
      `<div class="trend-sub">${t0.log.errorCount === 0 ? "clean over the last" : `over the last`} ${fmtDur(t0.log.windowMs)} · log ${fmtBytes(t0.log.sizeBytes)}</div>`,
      `</div>`,
    ].join(""),
    trendCard("behind", "Delivery lag", `${liveDeliveryBehind(snap.daemon)}`, "summed across online projects only (offline excluded)"),
    `</div>`,
  );

  out.push(`<div class="results">global results · <span class="mono">${snap.daemon.tier2.results.fileCount}</span> files · ${fmtBytes(snap.daemon.tier2.results.totalBytes)}</div>`);
  out.push(`</section>`);
  return out.join("");
}

// ── Tab: ENVIRONMENT ────────────────────────────────────────────────────────────
function probeTable(rows: Array<[string, Probe]>): string {
  return [
    `<table class="grid"><thead><tr><th>status</th><th>component</th><th>detail</th></tr></thead><tbody>`,
    ...rows.map(([label, p]) =>
      `<tr><td>${statePill(p.state)}</td><td class="mono">${esc(label)}</td><td class="dim">${p.detail ? esc(p.detail) : ""}</td></tr>`,
    ),
    `</tbody></table>`,
  ].join("");
}

function renderEnv(ext: ExternalProbes): string {
  const out: string[] = [`<section class="panel" data-panel="environment" role="tabpanel" aria-label="Environment">`];
  out.push(sectionHead("Environment · Tier 3 / 4", "External tools and on-disk state the cockpit depends on but does not own — agent CLIs, vaults, and config."));

  out.push(`<article class="card"><header class="card-head"><span class="card-title">Runtime & CLIs</span></header>`);
  out.push(probeTable([
    ["cmux", ext.cmux],
    ...ext.agentClis.map((c) => [c.cli, c] as [string, Probe]),
  ]));
  out.push(`</article>`);

  out.push(`<article class="card"><header class="card-head"><span class="card-title">Vaults</span></header>`);
  out.push(probeTable([
    ["hub", ext.vaults.hub],
    ...ext.vaults.spokes.map((s) => [`spoke · ${s.project}`, s] as [string, Probe]),
  ]));
  out.push(`</article>`);

  out.push(`<article class="card"><header class="card-head"><span class="card-title">Config integrity</span></header>`);
  out.push(probeTable([
    ["config.json", ext.config.parseable],
    ["sessions", ext.config.sessions],
    ...ext.config.projectPaths.map((p) => [`path · ${p.project}`, p] as [string, Probe]),
  ]));
  out.push(`</article>`);

  out.push(`</section>`);
  return out.join("");
}

// ── Tab nav + content assembly ──────────────────────────────────────────────────
const TABS: Array<[string, string]> = [
  ["overview", "Overview"],
  ["projects", "Projects"],
  ["daemon", "Daemon"],
  ["environment", "Environment"],
];

function tabNav(): string {
  const btns = TABS.map(([id, label], i) =>
    `<button class="tab${i === 0 ? " on" : ""}" data-tab="${id}" role="tab" aria-selected="${i === 0 ? "true" : "false"}">${esc(label)}</button>`,
  ).join("");
  return `<nav class="tabs" role="tablist">${btns}</nav>`;
}

function metricsBlob(col: Collected, linkLost: boolean): string {
  const m = {
    t: col.now,
    errors: linkLost ? 0 : col.errors,
    behind: linkLost ? 0 : col.behind,
    crewAgeMs: linkLost ? 0 : col.crewAgeMs,
    alive: col.overall.alive, stale: col.overall.stale, gone: col.overall.gone, unknown: col.overall.unknown,
  };
  // Escape `</` defensively so the JSON can never close the <script> early.
  const json = JSON.stringify(m).replace(/</g, "\\u003c");
  return `<script type="application/json" id="cockpit-metrics">${json}</script>`;
}

/** Pure. The live inner content (everything inside #content), re-pushed each tick. */
export function renderContent(snap: FullSnapshot): string {
  const col = collect(snap);
  const linkLost = snap.daemon === "unreachable";
  const mc = linkLost ? "crit" : masterClass(col.overall);
  const word = linkLost ? "LINK LOST" : MASTER_WORD[mc];

  const out: string[] = [
    `<header class="page-head">`,
    `<h1 class="page-title">COCKPIT SYSTEM HEALTH</h1>`,
    `<p class="page-sub">Live health of the cockpit daemon, sessions, message data plane, and environment — refreshed automatically every few seconds.</p>`,
    `</header>`,
  ];

  // Master annunciator (status summary) — glanceable on every tab.
  const sumLine = `${col.overall.alive} nominal · ${col.overall.stale} caution · ${col.overall.gone} fault · ${col.overall.unknown} unknown`;
  out.push(
    `<section class="annunciator a-${mc}" role="status" aria-label="Status summary">`,
    `<div class="ann-main"><span class="ann-eyebrow">Status summary</span><span class="ann-word">${esc(word)}</span></div>`,
    `<div class="ann-meta"><span class="ann-sum">${sumLine}</span><span class="ann-cap">worst current state across all ${col.overall.total} monitored components</span></div>`,
    `</section>`,
  );

  // Caution banners (loud, only when applicable).
  if (snap.daemon === "unreachable") {
    out.push(banner("err", "✘ DAEMON UNREACHABLE — start it: cockpit heal daemon  (external checks below still live)"));
  } else if (snap.daemon.tier0.build.state === "stale") {
    out.push(banner("warn", "⚠ DAEMON RUNNING STALE CODE — process started before the current dist build"));
    out.push(remediation("npm run build && cockpit heal daemon"));
  }

  out.push(tabNav());
  out.push(`<div class="panels">`);
  out.push(renderOverview(snap, col));
  out.push(renderProjects(snap, col.now));
  out.push(renderDaemon(snap));
  out.push(renderEnv(snap.external));
  out.push(`</div>`);

  out.push(metricsBlob(col, linkLost));
  return out.join("\n");
}

/** Pure. The per-tick SSE payload: re-rendered content + the snapshot timestamp. */
export function renderTickJson(snap: FullSnapshot): string {
  return JSON.stringify({ contentHtml: renderContent(snap), generatedAt: snap.generatedAt });
}

const STYLE = `
:root{
  --bg:#f6f7f9;--panel:#ffffff;--panel-2:#eef1f6;--bezel:#e3e7ef;--track:#e9ecf2;
  --ink:#1b2333;--ink-dim:#5b6678;--hud:#0b6fc2;--hud-deep:#0b6fc2;
  --ok:#157f3c;--warn:#b45309;--crit:#c01f2e;--unk:#5f6b7d;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 4px 14px rgba(16,24,40,.06);
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(1200px 760px at 50% -260px,#eaf1fb 0%,var(--bg) 58%);color:var(--ink);
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}

/* Flight deck header (persistent shell) */
.deck{display:flex;align-items:center;gap:18px;padding:14px 22px;border-bottom:1px solid var(--bezel);
  background:linear-gradient(180deg,rgba(255,255,255,.92),rgba(255,255,255,.62));position:sticky;top:0;z-index:5;backdrop-filter:blur(8px)}
.brand{display:flex;align-items:center;gap:11px}
.led{width:10px;height:10px;border-radius:50%;background:var(--unk);box-shadow:0 0 0 0 rgba(55,198,238,.5)}
.led.live{background:var(--ok);animation:beat 2.2s ease-in-out infinite}
.led.down{background:var(--crit);animation:blink 1s steps(2) infinite}
.wordmark{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:800;letter-spacing:.34em;font-size:15px;text-transform:uppercase}
.tagline{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.26em;font-size:9.5px;color:var(--hud)}
.deck-spacer{flex:1}
.readout{display:flex;align-items:center;gap:16px;font-size:11px}
.conn{font-family:system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-dim)}
.conn.live{color:var(--ok)}.conn.down{color:var(--crit)}
.updated{color:var(--ink-dim)}
.port{color:var(--hud)}

#content{max-width:1080px;margin:0 auto;padding:18px 22px 64px;transition:opacity .18s ease}
#content.swap{animation:fade .26s ease}

/* Page heading + section headings */
.page-head{margin:2px 0 16px}
.page-title{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:800;font-size:20px;letter-spacing:.06em;color:var(--ink)}
.page-sub{margin:5px 0 0;color:var(--ink-dim);font-size:13px;max-width:74ch}
.section-head{margin:20px 0 10px}
.section-title{margin:0;font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-weight:700;color:var(--ink)}
.section-sub{margin:3px 0 0;color:var(--ink-dim);font-size:12px}

/* Annunciator */
.annunciator{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:14px 18px;border-radius:12px;margin-bottom:6px;
  border:1px solid var(--bezel);background:var(--panel);box-shadow:var(--shadow);position:relative;overflow:hidden}
.annunciator::before{content:"";position:absolute;inset:0 auto 0 0;width:4px}
.ann-main{display:flex;flex-direction:column;gap:2px}
.ann-eyebrow{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.16em;font-size:9px;color:var(--ink-dim)}
.ann-meta{display:flex;flex-direction:column;gap:2px;text-align:right;min-width:0}
.ann-word{font-family:system-ui,sans-serif;font-weight:800;letter-spacing:.2em;font-size:21px}
.ann-sum{color:var(--ink);letter-spacing:.04em;font-size:12px}
.ann-cap{color:var(--ink-dim);font-size:11px}
@media (max-width:560px){.ann-meta{text-align:left}}
.a-ok .ann-word{color:var(--ok)}.a-ok::before{background:var(--ok);box-shadow:0 0 18px var(--ok)}
.a-warn .ann-word{color:var(--warn)}.a-warn::before{background:var(--warn);box-shadow:0 0 18px var(--warn)}
.a-crit .ann-word{color:var(--crit)}.a-crit::before{background:var(--crit);box-shadow:0 0 18px var(--crit);animation:pulseBar 1.4s ease-in-out infinite}

/* Banners */
.banner{padding:10px 14px;border-radius:10px;margin:10px 0;font-weight:700;letter-spacing:.02em;border:1px solid transparent}
.banner.err{background:#fdecee;color:#b21f2c;border-color:#f3c3c9}
.banner.warn{background:#fff5e1;color:#8a5806;border-color:#f0d8a4}
.rem{color:var(--ink-dim);margin:6px 0;font-size:12px}
.rem code,.empty code{background:var(--panel-2);padding:2px 7px;border-radius:5px;color:var(--hud);user-select:all;border:1px solid var(--bezel)}

/* Tabs */
.tabs{display:flex;gap:4px;margin:6px 0 16px;border-bottom:1px solid var(--bezel);flex-wrap:wrap}
.tab{appearance:none;background:none;border:0;color:var(--ink-dim);cursor:pointer;padding:9px 16px;
  font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:600;
  border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s ease,border-color .15s ease}
.tab:hover{color:var(--ink)}
.tab.on{color:var(--hud);border-bottom-color:var(--hud)}
.panel{animation:none}
.panel.fade{animation:fade .28s ease}

/* Overview hero */
.hero{display:flex;gap:30px;align-items:center;flex-wrap:wrap;padding:22px;border-radius:14px;
  border:1px solid var(--bezel);background:linear-gradient(180deg,var(--panel-2),var(--panel));box-shadow:var(--shadow);margin-bottom:16px}
.gauge{position:relative;width:172px;height:172px;flex:none}
.donut{width:172px;height:172px;animation:rise .55s ease}
.donut-track{stroke:var(--track)}
.seg{transition:stroke-dasharray .5s ease}
.seg.s-alive{stroke:var(--ok)}.seg.s-stale{stroke:var(--warn)}.seg.s-gone{stroke:var(--crit)}.seg.s-unknown{stroke:var(--unk)}
.a-ok .seg.s-alive{filter:drop-shadow(0 0 4px var(--ok))}
.gauge-core{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1px}
.gauge-n{font-size:38px;font-weight:800;font-family:system-ui,sans-serif;line-height:1}
.gauge-word{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.14em;font-size:11px;color:var(--ink-dim)}
.a-ok .gauge-word{color:var(--ok)}.a-warn .gauge-word{color:var(--warn)}.a-crit .gauge-word{color:var(--crit)}
.gauge-cap{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-dim)}
.legend{display:grid;grid-template-columns:1fr 1fr;gap:10px 22px;flex:1;min-width:200px}
.leg{display:flex;align-items:center;gap:9px}
.leg-n{font-size:20px;font-weight:700;font-family:system-ui,sans-serif;min-width:1.4em;text-align:right}
.leg-l{color:var(--ink-dim);text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-family:system-ui,sans-serif}
.leg.s-alive .pdot{background:var(--ok)}.leg.s-stale .pdot{background:var(--warn)}
.leg.s-gone .pdot{background:var(--crit)}.leg.s-unknown .pdot{background:var(--unk)}

/* Tier + trend cards */
.tier-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}
.tier-card{border:1px solid var(--bezel);border-radius:12px;background:var(--panel);padding:14px 16px;box-shadow:var(--shadow)}
.tier-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.tier-name{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--ink)}
.tier-desc{margin:0 0 12px;color:var(--ink-dim);font-size:11px;min-height:2.2em}
.tier-counts{display:flex;gap:14px}
.tc{display:flex;flex-direction:column;font-size:21px;font-weight:700;font-family:system-ui,sans-serif;line-height:1.1}
.tc i{font-size:9px;font-weight:600;font-style:normal;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim)}
.tc.s-alive{color:var(--ok)}.tc.s-stale{color:var(--warn)}.tc.s-gone{color:var(--crit)}.tc.s-unknown{color:var(--unk)}

.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:16px}
.trend{border:1px solid var(--bezel);border-radius:12px;background:var(--panel);padding:13px 15px;box-shadow:var(--shadow)}
.trend-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.trend-l{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;font-size:10px;color:var(--ink-dim)}
.trend-v{font-size:18px;font-weight:700;font-family:system-ui,sans-serif;color:var(--hud)}
.trend-sub{color:var(--ink-dim);font-size:11px;margin-top:7px}
.spark{width:100%;height:34px;display:block}
.spark-line{fill:none;stroke:var(--hud);stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.spark-area{fill:var(--hud);opacity:.1}
.spark-dot{fill:var(--hud)}

/* Cards / tables */
.card{border:1px solid var(--bezel);border-radius:12px;background:var(--panel);box-shadow:var(--shadow);padding:14px 16px;margin-bottom:14px;border-left:3px solid var(--bezel)}
.card[data-rollup="gone"]{border-left-color:var(--crit)}
.card[data-rollup="stale"]{border-left-color:var(--warn)}
.card[data-rollup="alive"]{border-left-color:var(--ok)}
.card[data-rollup="unknown"]{border-left-color:var(--unk)}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.card-title{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-weight:600}
.grid{width:100%;border-collapse:collapse;font-size:12px}
.grid th{text-align:left;font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:9px;
  color:var(--ink-dim);font-weight:600;padding:4px 10px 8px;border-bottom:1px solid var(--bezel)}
.grid td{padding:6px 10px;border-bottom:1px solid var(--track);vertical-align:middle}
.grid tr:last-child td{border-bottom:0}
.rem-row td{padding-top:0;border-bottom:0}
.mono{font-family:ui-monospace,monospace}
.dim{color:var(--ink-dim)}.small{font-size:11px}

/* Pills */
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px;
  border:1px solid var(--bezel);background:var(--panel-2);white-space:nowrap}
.pdot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--unk)}
.pill.s-alive{color:var(--ok)}.pill.s-alive .pdot{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.pill.s-stale{color:var(--warn)}.pill.s-stale .pdot{background:var(--warn);box-shadow:0 0 6px var(--warn)}
.pill.s-gone{color:var(--crit)}.pill.s-gone .pdot{background:var(--crit);box-shadow:0 0 6px var(--crit)}
.pill.s-unknown{color:var(--unk)}.pill.s-unknown .pdot{background:var(--unk)}
.cell-detail{color:var(--ink-dim)}

/* Project data-plane */
.dp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:14px;
  padding-top:13px;border-top:1px solid var(--bezel)}
.dp-block{display:flex;flex-direction:column;gap:6px}
.dp-l{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.1em;font-size:9px;color:var(--ink-dim)}
.dp-v{font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.dbar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:var(--track);border:1px solid var(--bezel)}
.dbar-acked{background:var(--ok);transition:width .5s ease}
.dbar-behind{background:var(--warn);transition:width .5s ease}
.results{color:var(--ink-dim);font-size:12px;margin-top:8px}

/* Daemon instruments */
.instr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.instr{border:1px solid var(--bezel);border-radius:12px;background:var(--panel);padding:13px 15px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:7px}
.instr-l{font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;font-size:9px;color:var(--ink-dim)}
.instr-v{font-size:15px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.instr-sub{color:var(--ink-dim);font-size:11px}

.empty{border:1px dashed var(--bezel);border-radius:12px;padding:24px;color:var(--ink-dim);text-align:center;background:var(--panel)}

:focus-visible{outline:2px solid var(--hud);outline-offset:2px;border-radius:4px}

@keyframes beat{0%,100%{box-shadow:0 0 0 0 rgba(58,210,159,.45)}50%{box-shadow:0 0 0 6px rgba(58,210,159,0)}}
@keyframes blink{50%{opacity:.35}}
@keyframes pulseBar{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes rise{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:640px){.hero{gap:18px}.deck{padding:12px 14px;gap:10px}.tagline{display:none}#content{padding:14px}}
`.trim();

// Persistent client controller: tab switching (event-delegated), rolling history
// for sparklines, count-ups, and the SSE wiring. Lives in the shell so it is set
// up ONCE and survives every #content swap; `refresh()` reapplies tab + redraws
// charts after each frame.
const CLIENT_JS = `
(function(){
  var activeTab='overview';var hist={};var prev={};
  function pushHist(k,v,t){var a=hist[k]||(hist[k]=[]);if(a.length&&a[a.length-1].t===t)return;a.push({t:t,v:v});if(a.length>48)a.shift();}
  function ingest(){var el=document.getElementById('cockpit-metrics');if(!el)return;var m;try{m=JSON.parse(el.textContent);}catch(e){return;}pushHist('errors',m.errors,m.t);pushHist('behind',m.behind,m.t);pushHist('crewAge',Math.round(m.crewAgeMs/1000),m.t);}
  function sparkSVG(a){var W=100,H=28,p=2;if(!a.length)return'';var vs=a.map(function(x){return x.v;});var mx=Math.max.apply(null,vs),mn=Math.min.apply(null,vs);if(mx===mn)mx=mn+1;var n=a.length;var pts=a.map(function(x,i){var px=n>1?p+i/(n-1)*(W-2*p):W/2;var py=H-p-(x.v-mn)/(mx-mn)*(H-2*p);return[px,py];});var d=pts.map(function(pt,i){return(i?'L':'M')+pt[0].toFixed(1)+' '+pt[1].toFixed(1);}).join(' ');var last=pts[pts.length-1];var area=d+' L'+last[0].toFixed(1)+' '+H+' L'+pts[0][0].toFixed(1)+' '+H+' Z';return'<path class="spark-area" d="'+area+'"/><path class="spark-line" d="'+d+'"/><circle class="spark-dot" cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="2"/>';}
  function drawSparks(){var ns=document.querySelectorAll('[data-spark]');for(var i=0;i<ns.length;i++){ns[i].innerHTML=sparkSVG(hist[ns[i].getAttribute('data-spark')]||[]);}}
  function applyTab(){var ts=document.querySelectorAll('[data-tab]');for(var i=0;i<ts.length;i++){var on=ts[i].getAttribute('data-tab')===activeTab;ts[i].setAttribute('aria-selected',on?'true':'false');ts[i].classList.toggle('on',on);}var ps=document.querySelectorAll('[data-panel]');for(var j=0;j<ps.length;j++){var on2=ps[j].getAttribute('data-panel')===activeTab;ps[j].hidden=!on2;}}
  function ease(k){return k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;}
  function countUps(){var ns=document.querySelectorAll('[data-countup]');for(var i=0;i<ns.length;i++){(function(el){var key=el.getAttribute('data-countup');var to=parseFloat(el.getAttribute('data-value'))||0;var from=prev[key]!=null?prev[key]:0;prev[key]=to;if(from===to){el.textContent=to;return;}var s=null;function step(ts){if(s===null)s=ts;var k=Math.min(1,(ts-s)/600);el.textContent=Math.round(from+(to-from)*ease(k));if(k<1)requestAnimationFrame(step);}requestAnimationFrame(step);})(ns[i]);}}
  function refresh(){ingest();applyTab();drawSparks();countUps();}
  document.addEventListener('click',function(e){var t=e.target&&e.target.closest?e.target.closest('[data-tab]'):null;if(t){activeTab=t.getAttribute('data-tab');applyTab();var c=document.getElementById('content');if(c){c.classList.remove('swap');void c.offsetWidth;c.classList.add('swap');}}});
  document.addEventListener('keydown',function(e){var ae=document.activeElement;if((e.key==='ArrowRight'||e.key==='ArrowLeft')&&ae&&ae.getAttribute&&ae.getAttribute('data-tab')){var o=['overview','projects','daemon','environment'];var i=o.indexOf(activeTab);i=(i+(e.key==='ArrowRight'?1:o.length-1))%o.length;activeTab=o[i];applyTab();var nt=document.querySelector('[data-tab="'+activeTab+'"]');if(nt)nt.focus();e.preventDefault();}});
  var led=document.getElementById('led');var conn=document.getElementById('conn');var updated=document.getElementById('updated');
  function tickAge(){if(!generatedAt)return;var s=Math.max(0,Math.round((Date.now()-generatedAt)/1000));updated.textContent='updated '+s+'s ago';}
  setInterval(tickAge,1000);
  var es=new EventSource('/events');
  es.onopen=function(){conn.textContent='live';conn.className='conn live';led.className='led live';};
  es.onerror=function(){conn.textContent='reconnecting';conn.className='conn down';led.className='led down';};
  es.onmessage=function(e){try{var d=JSON.parse(e.data);document.getElementById('content').innerHTML=d.contentHtml;generatedAt=d.generatedAt;tickAge();refresh();}catch(_){}};
  refresh();tickAge();
})();
`.trim();

/** Pure. The full HTML document for the initial GET / load (shell + content + SSE JS). */
export function renderHtml(snap: FullSnapshot, opts: { port?: number } = {}): string {
  const port = opts.port ? `:${opts.port}` : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>cockpit · system health</title>",
    `<style>${STYLE}</style></head><body class="theme-light">`,
    `<header class="deck">`,
    `<div class="brand"><span class="led" id="led"></span><span class="wordmark">Cockpit</span><span class="tagline">Mission Control</span></div>`,
    `<span class="deck-spacer"></span>`,
    `<div class="readout"><span class="conn" id="conn">connecting</span><span class="updated" id="updated"></span><span class="port">${esc(port)}</span></div>`,
    `</header>`,
    `<main id="content">${renderContent(snap)}</main>`,
    `<script>let generatedAt=${snap.generatedAt};${CLIENT_JS}</script>`,
    "</body></html>",
  ].join("");
}
