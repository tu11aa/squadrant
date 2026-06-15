// src/dashboard/web-render.ts
//
// PURE render of a FullSnapshot to (a) a complete HTML document for the initial
// GET / load and (b) a per-tick JSON payload pushed over SSE. No I/O, no clock —
// every age is derived from snapshot-time deltas or `snap.generatedAt`, so the
// render is deterministic and unit-tested. Severity rolls UP (a `gone` bubbles a
// red dot to its project header); the stale-build banner renders only when stale;
// remediation is COPY-ABLE TEXT via healCmdFor() (never buttons — read-only beta).
import type { HealthState, ComponentHealth } from "../control/liveness.js";
import { healCmdFor } from "../commands/heal.js";
import { ageText } from "../commands/health-view.js";
import type { FullSnapshot } from "./snapshot-merge.js";
import type { DaemonSnapshot } from "../control/snapshot.js";
import type { ExternalProbes, Probe, ProbeState } from "./probes.js";

type AnyState = HealthState | ProbeState;

const ICON: Record<AnyState, string> = { alive: "✔", stale: "•", gone: "✘", unknown: "○" };
// Rollup ordering: gone is worst, unknown never out-ranks a real degradation.
const SEV: Record<AnyState, number> = { alive: 0, unknown: 1, stale: 2, gone: 3 };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dot(state: AnyState): string {
  return `<span class="s-${state}">${ICON[state]}</span>`;
}

function worst(states: AnyState[]): AnyState {
  let w: AnyState = "alive";
  for (const s of states) if (SEV[s] > SEV[w]) w = s;
  return w;
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

function banner(kind: "err" | "warn", text: string): string {
  return `<div class="banner ${kind}">${esc(text)}</div>`;
}

function remediation(text: string): string {
  // Copy-able text, NOT a button — read-only beta surface.
  return `<div class="rem">remediation: <code>${esc(text)}</code></div>`;
}

function probeCell(label: string, p: Probe): string {
  const detail = p.detail ? ` <span class="dim">${esc(p.detail)}</span>` : "";
  return `${dot(p.state)} ${esc(label)}${detail}`;
}

// ── Tier 0 — daemon root ──────────────────────────────────────────────────────
function renderTier0(d: DaemonSnapshot): string {
  const t0 = d.tier0;
  const buildState: HealthState = t0.build.state === "fresh" ? "alive" : "gone";
  const sweep = t0.sweep.ageMs == null ? "never swept" : `last ${fmtAge(t0.sweep.ageMs)} (${fmtDur(t0.sweep.cadenceMs)} cadence)`;
  const logState: HealthState = t0.log.errorCount > 0 ? "stale" : "alive";
  return [
    `<section><h2>TIER 0 · DAEMON</h2>`,
    `<div class="row">${dot("alive")} cockpitd pid ${t0.pid} · up ${fmtDur(t0.uptimeMs)} · v${esc(t0.version)}</div>`,
    `<div class="row">${dot(buildState)} build ${t0.build.state} · sweep ${esc(sweep)}</div>`,
    `<div class="row">${dot(logState)} log ${t0.log.errorCount} errors/${fmtDur(t0.log.windowMs)} (${fmtBytes(t0.log.sizeBytes)})</div>`,
    `</section>`,
  ].join("");
}

// ── Tier 3/4 — environment ────────────────────────────────────────────────────
function renderEnv(ext: ExternalProbes): string {
  const clis = ext.agentClis.map((c) => probeCell(c.cli, c)).join(" ");
  const spokes = ext.vaults.spokes.map((s) => probeCell(s.project, s)).join(" ");
  const paths = ext.config.projectPaths.map((p) => probeCell(p.project, p)).join(" ");
  return [
    `<section><h2>TIER 3/4 · ENVIRONMENT</h2>`,
    `<div class="row">${probeCell("cmux", ext.cmux)}</div>`,
    `<div class="row">CLIs: ${clis}</div>`,
    `<div class="row">vaults: ${probeCell("hub", ext.vaults.hub)} ${spokes}</div>`,
    `<div class="row">config: ${probeCell("config.json", ext.config.parseable)} ${probeCell("sessions", ext.config.sessions)} ${paths}</div>`,
    `</section>`,
  ].join("");
}

// ── Tier 1/2 — projects ───────────────────────────────────────────────────────
function renderComponentRow(c: ComponentHealth, now: number): string {
  const detail = c.detail ? ` · ${esc(c.detail)}` : "";
  const row = `<div class="row comp">${dot(c.state)} ${esc(c.kind)} ${esc(c.ref)} ${esc(ageText(c.lastSeenMs, now))}${detail}</div>`;
  const heal = healCmdFor(c);
  return heal ? row + remediation(heal) : row;
}

function renderProjects(d: DaemonSnapshot, now: number): string {
  const projects = new Set<string>([
    ...d.tier1.map((c) => c.project),
    ...d.tier2.projects.map((p) => p.project),
  ]);
  const out: string[] = [`<section><h2>PROJECTS</h2>`];
  for (const project of projects) {
    const comps = d.tier1.filter((c) => c.project === project);
    const dp = d.tier2.projects.find((p) => p.project === project);
    const rollupStates: AnyState[] = [
      ...comps.map((c) => c.state),
      dp && dp.delivery.behind > 0 ? "stale" : "alive",
      dp && dp.store.corruptCount > 0 ? "gone" : "alive",
    ];
    const rollup = worst(rollupStates);
    out.push(`<div class="proj"><div class="proj-head" data-rollup="${rollup}">${esc(project)} ${dot(rollup)}</div>`);
    for (const c of comps) out.push(renderComponentRow(c, now));
    if (dp) {
      const counts = Object.entries(dp.store.byState).map(([s, n]) => `${n} ${esc(s)}`).join(" · ") || "no tasks";
      out.push(
        `<div class="row dp">mailbox: ${dp.mailbox.maxSeq} entries · captain ${dp.delivery.behind} behind · ${fmtBytes(dp.mailbox.sizeBytes)} · rotated ${dp.mailbox.rotationCount} · oldest ${fmtAge(dp.mailbox.oldestEntryAgeMs)}</div>`,
        `<div class="row dp">store: ${counts} · ${dp.store.corruptCount} corrupt</div>`,
      );
    }
    out.push(`</div>`);
  }
  out.push(
    `<div class="row dp">_results: ${d.tier2.results.fileCount} files (${fmtBytes(d.tier2.results.totalBytes)})</div>`,
    `</section>`,
  );
  return out.join("");
}

/** Pure. The live inner content (everything inside #content), re-pushed each tick. */
export function renderContent(snap: FullSnapshot): string {
  const now = snap.generatedAt;
  const out: string[] = [`<h1>🚀 COCKPIT SYSTEM HEALTH</h1>`];

  if (snap.daemon === "unreachable") {
    out.push(banner("err", "✘ DAEMON UNREACHABLE — start it: cockpit heal daemon  (external checks below still live)"));
  } else if (snap.daemon.tier0.build.state === "stale") {
    out.push(banner("warn", "⚠ DAEMON RUNNING STALE CODE — process started before the current dist build"));
    out.push(remediation("npm run build && cockpit heal daemon"));
  }

  if (snap.daemon !== "unreachable") out.push(renderTier0(snap.daemon));
  out.push(renderEnv(snap.external));
  if (snap.daemon !== "unreachable") out.push(renderProjects(snap.daemon, now));

  return out.join("\n");
}

/** Pure. The per-tick SSE payload: re-rendered content + the snapshot timestamp. */
export function renderTickJson(snap: FullSnapshot): string {
  return JSON.stringify({ contentHtml: renderContent(snap), generatedAt: snap.generatedAt });
}

const STYLE = `
body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0e14;color:#c9d1d9;margin:0;padding:16px}
h1{font-size:16px;margin:0 0 8px}h2{font-size:12px;color:#7d8590;letter-spacing:.08em;margin:16px 0 4px}
#bar{display:flex;gap:16px;align-items:center;color:#7d8590;font-size:12px;margin-bottom:8px}
#conn.live{color:#3fb950}#conn.down{color:#f85149}
.row{padding:1px 0}.comp{padding-left:16px}.dp{padding-left:16px;color:#7d8590}
.proj{margin:8px 0;border-left:2px solid #21262d;padding-left:8px}
.proj-head{font-weight:600}
.proj-head[data-rollup="gone"]{color:#f85149}.proj-head[data-rollup="stale"]{color:#d29922}
.proj-head[data-rollup="unknown"]{color:#7d8590}
.banner{padding:8px 12px;border-radius:6px;margin:8px 0;font-weight:600}
.banner.err{background:#3d1416;color:#ff7b72}.banner.warn{background:#3d2e0a;color:#e3b341}
.rem{padding-left:16px;color:#7d8590}.rem code{background:#161b22;padding:1px 6px;border-radius:4px;color:#79c0ff;user-select:all}
.dim{color:#6e7681}
.s-alive{color:#3fb950}.s-stale{color:#d29922}.s-gone{color:#f85149}.s-unknown{color:#6e7681}
`.trim();

/** Pure. The full HTML document for the initial GET / load (shell + content + SSE JS). */
export function renderHtml(snap: FullSnapshot, opts: { port?: number } = {}): string {
  const port = opts.port ? `:${opts.port}` : "";
  const script = [
    "const conn=document.getElementById('conn');",
    "const updated=document.getElementById('updated');",
    `let generatedAt=${snap.generatedAt};`,
    "function tickAge(){if(!generatedAt)return;const s=Math.max(0,Math.round((Date.now()-generatedAt)/1000));updated.textContent='updated '+s+'s ago';}",
    "setInterval(tickAge,1000);tickAge();",
    "const es=new EventSource('/events');",
    "es.onopen=function(){conn.textContent='\\u25CF live';conn.className='live';};",
    "es.onerror=function(){conn.textContent='\\u25CB reconnecting';conn.className='down';};",
    "es.onmessage=function(e){try{const d=JSON.parse(e.data);document.getElementById('content').innerHTML=d.contentHtml;generatedAt=d.generatedAt;tickAge();}catch(_){}};",
  ].join("");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>cockpit system health</title>",
    `<style>${STYLE}</style></head><body>`,
    `<div id="bar"><span id="conn">○ connecting</span><span id="updated"></span><span>${esc(port)}</span></div>`,
    `<div id="content">${renderContent(snap)}</div>`,
    `<script>${script}</script>`,
    "</body></html>",
  ].join("");
}
