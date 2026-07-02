import { describe, it, expect } from "vitest";
import { renderHtml, renderContent, renderTickJson } from "../web-render.js";
import type { FullSnapshot } from "../snapshot-merge.js";
import type { DaemonSnapshot } from "@squadrant/core";
import type { ExternalProbes } from "../probes.js";

const externalHealthy: ExternalProbes = {
  cmux: { state: "alive" },
  agentClis: [
    { cli: "claude", state: "alive" },
    { cli: "codex", state: "alive" },
    { cli: "gemini", state: "alive" },
    { cli: "opencode", state: "alive" },
  ],
  vaults: { hub: { path: "/h", state: "alive" }, spokes: [{ project: "squadrant", path: "/s", state: "alive" }] },
  config: { parseable: { state: "alive" }, projectPaths: [{ project: "squadrant", path: "/r", state: "alive" }], sessions: { state: "alive" } },
};

function daemon(over: Partial<DaemonSnapshot["tier0"]> = {}, tier1: DaemonSnapshot["tier1"] = []): DaemonSnapshot {
  return {
    tier0: {
      pid: 4821, uptimeMs: 6 * 3600_000, version: "0.6.1",
      build: { state: "fresh", processStartedAt: 2000, distBuiltAt: 1000 },
      sweep: { lastSweepAt: 1000, ageMs: 8000, cadenceMs: 30_000 },
      log: { errorCount: 0, sizeBytes: 100, windowMs: 3_600_000 },
      telegram: { configured: false, polling: false, lastSuccessfulPollAt: null, lastError: null, lastErrorAt: null },
      lifecycleSources: [],
      ...over,
    },
    tier1,
    tier2: {
      projects: [
        {
          project: "squadrant",
          mailbox: { maxSeq: 12, sizeBytes: 1300, oldestEntryAgeMs: 60_000, rotationCount: 0 },
          delivery: { maxSeq: 12, lastAckedSeq: 12, behind: 0 },
          store: { byState: { working: 3, blocked: 1 }, corruptCount: 0 },
          deferral: { maxDeferCount: 0, stuck: false },
        },
      ],
      results: { fileCount: 294, totalBytes: 18_000_000 },
    },
  };
}

function full(d: DaemonSnapshot | "unreachable", external = externalHealthy, generatedAt = 1_000_000): FullSnapshot {
  return { generatedAt, daemon: d, external };
}

describe("renderHtml", () => {
  it("emits a full HTML document with the live content and an SSE connection indicator", () => {
    const html = renderHtml(full(daemon()));
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("SQUADRANT SYSTEM HEALTH"); // visible page heading
    expect(html).toContain('id="content"');
    expect(html).toContain('id="conn"');
    expect(html).toContain('id="led"'); // pulsing live indicator in the flight deck
    expect(html).toContain("EventSource"); // bootstrap JS wires the SSE stream
    expect(html).toContain("updated"); // "updated Ns ago" readout
  });

  it("ships the light theme — light background, dark ink, no dark mission-control palette", () => {
    const html = renderHtml(full(daemon()));
    expect(html).toContain('class="theme-light"');
    expect(html).toContain("--bg:#f6f7f9"); // near-white page background
    expect(html).toContain("--panel:#ffffff"); // white cards
    expect(html).toContain("--ink:#1b2333"); // dark high-contrast text
    expect(html).not.toContain("#070b14"); // the old dark page background is gone
  });
});

describe("explanatory titles + captions", () => {
  it("gives the page a heading and a plain-language subtitle", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('class="page-title"');
    expect(out).toContain('class="page-sub"');
    expect(out).toContain("Live health of the squadrant daemon");
  });

  it("titles every Overview block with a heading + caption", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('class="section-head"');
    expect(out).toContain("System Health");
    expect(out).toContain("Health by Tier");
    expect(out).toContain("Live Trends");
    // the donut number is explained in plain language
    expect(out).toContain("monitored components are alive");
  });

  it("labels the status summary annunciator and each tier card", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain("Status summary");
    expect(out).toContain('class="tier-desc"');
    expect(out).toContain("Tier 0"); // daemon tier described
    expect(out).toContain("Tier 3/4"); // environment tier described
  });

  it("introduces the other tabs so their tables are not ambiguous", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain("Daemon · Tier 0");
    expect(out).toContain("Environment · Tier 3 / 4");
    expect(out).toContain("mailbox delivery and task store"); // projects intro
  });
});

describe("tabbed navigation", () => {
  it("renders all four tabs as a tablist", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('role="tablist"');
    for (const tab of ["overview", "projects", "daemon", "environment"]) {
      expect(out).toContain(`data-tab="${tab}"`);
      expect(out).toContain(`data-panel="${tab}"`);
    }
    expect(out).toContain("Overview");
    expect(out).toContain("Environment");
  });
});

describe("overview gauge + charts", () => {
  it("renders an inline-SVG health donut and a master annunciator", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('<svg class="donut"'); // the signature SVG gauge
    expect(out).toContain('class="seg s-alive"'); // proportional segment
    expect(out).toContain('class="annunciator'); // master flight status
    expect(out).toContain("NOMINAL"); // all-healthy master word
  });

  it("renders sparkline chart nodes the client fills from rolling history", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('data-spark="errors"');
    expect(out).toContain('data-spark="behind"');
    expect(out).toContain('<svg class="spark"');
  });

  it("emits a machine-readable metrics blob for client-side trends", () => {
    const out = renderContent(full(daemon()));
    expect(out).toContain('id="squadrant-metrics"');
    const m = out.match(/id="squadrant-metrics">(.*?)<\/script>/s);
    expect(m).not.toBeNull();
    const metrics = JSON.parse(m![1]);
    expect(metrics.t).toBe(1_000_000);
    expect(typeof metrics.alive).toBe("number");
  });

  it("escalates the master annunciator to CRITICAL when a component is gone", () => {
    const goneCrew: DaemonSnapshot["tier1"] = [
      { kind: "crew", project: "squadrant", ref: "x", state: "gone", lastSeenMs: 1 },
    ];
    const out = renderContent(full(daemon({}, goneCrew)));
    expect(out).toContain('class="annunciator a-crit');
    expect(out).toContain("CRITICAL");
  });
});

describe("status pills", () => {
  it("renders color-coded status pills with a dot", () => {
    const tier1: DaemonSnapshot["tier1"] = [
      { kind: "captain", project: "squadrant", ref: "cap", state: "alive", lastSeenMs: 999_000 },
    ];
    const out = renderContent(full(daemon({}, tier1)));
    expect(out).toContain('class="pill s-alive"');
    expect(out).toContain('class="pdot"');
  });
});

describe("stale-build banner", () => {
  it("renders the loud banner only when the build is stale", () => {
    const stale = renderContent(full(daemon({ build: { state: "stale", processStartedAt: 1000, distBuiltAt: 9999 } })));
    expect(stale).toContain("DAEMON RUNNING STALE CODE");
    // remediation is copy-able text, not a button
    expect(stale).toContain("npm run build");
    expect(stale).not.toContain("<button class=\"banner");
  });
  it("omits the banner when the build is fresh", () => {
    expect(renderContent(full(daemon()))).not.toContain("DAEMON RUNNING STALE CODE");
  });
});

describe("daemon sweep wording", () => {
  it("says 'awaiting first sweep' when the daemon has not swept yet (fix a)", () => {
    const out = renderContent(full(daemon({ sweep: { lastSweepAt: null, ageMs: null, cadenceMs: 30_000 } })));
    expect(out).toContain("awaiting first sweep");
    expect(out).not.toContain("never swept");
  });
  it("shows the last-swept age once a sweep has run", () => {
    const out = renderContent(full(daemon({ sweep: { lastSweepAt: 1000, ageMs: 8000, cadenceMs: 30_000 } })));
    expect(out).toContain("cadence");
  });
});

describe("daemon log error metric (fix b)", () => {
  it("presents log errors as a calm caution metric with a sparkline, never a red master alarm", () => {
    const out = renderContent(full(daemon({ log: { errorCount: 7, sizeBytes: 4096, windowMs: 3_600_000 } })));
    expect(out).toContain("Log errors");
    expect(out).toContain('data-spark="errors"');
    // 7 log errors must NOT push the master annunciator to CRITICAL.
    expect(out).toContain('class="annunciator a-warn');
    expect(out).not.toContain('class="annunciator a-crit');
  });
});

describe("telegram bridge health (B3)", () => {
  it("shows 'not configured' (unknown) when no bridge is set up", () => {
    const out = renderContent(full(daemon({
      telegram: { configured: false, polling: false, lastSuccessfulPollAt: null, lastError: null, lastErrorAt: null },
    })));
    expect(out).toContain("telegram");
    expect(out).toContain("not configured");
  });

  it("shows a healthy polling state when configured with no error", () => {
    const out = renderContent(full(daemon({
      telegram: { configured: true, polling: true, lastSuccessfulPollAt: 999_900, lastError: null, lastErrorAt: null },
    })));
    expect(out).toMatch(/polling/i);
  });

  it("flags a dead poll loop (configured but not polling) as a fault, not a false green", () => {
    const out = renderContent(full(daemon({
      telegram: { configured: true, polling: false, lastSuccessfulPollAt: 500_000, lastError: null, lastErrorAt: null },
    })));
    expect(out).toMatch(/data-panel="daemon"[\s\S]*telegram[\s\S]*?s-gone/);
  });

  it("shows the last poll error as a caution while still polling", () => {
    const out = renderContent(full(daemon({
      telegram: { configured: true, polling: true, lastSuccessfulPollAt: 900_000, lastError: "getUpdates 401 Unauthorized", lastErrorAt: 950_000 },
    })));
    expect(out).toContain("getUpdates 401 Unauthorized");
  });
});

describe("lifecycle source health (B4)", () => {
  it("renders no source rows when none are registered", () => {
    const out = renderContent(full(daemon({ lifecycleSources: [] })));
    expect(out).not.toContain("cmux-store");
  });

  it("renders an active source as healthy", () => {
    const out = renderContent(full(daemon({
      lifecycleSources: [{ name: "cmux-store", active: true, error: null }],
    })));
    expect(out).toContain("cmux-store");
    expect(out).toMatch(/cmux-store[\s\S]*?s-alive/);
  });

  it("flags an inactive source as a fault", () => {
    const out = renderContent(full(daemon({
      lifecycleSources: [{ name: "native-hook", active: false, error: null }],
    })));
    expect(out).toMatch(/native-hook[\s\S]*?s-gone/);
  });

  it("flags an active-but-errored source as a caution and shows the error text", () => {
    const out = renderContent(full(daemon({
      lifecycleSources: [{ name: "cmux-store", active: true, error: "ENOSPC: watch failed" }],
    })));
    expect(out).toMatch(/cmux-store[\s\S]*?s-stale/);
    expect(out).toContain("ENOSPC: watch failed");
  });
});

describe("daemon unreachable", () => {
  it("shows the unreachable banner but still renders Tier 3/4", () => {
    const out = renderContent(full("unreachable"));
    expect(out).toContain("DAEMON UNREACHABLE");
    expect(out).toContain('class="annunciator a-crit'); // master goes critical
    expect(out).toContain("LINK LOST");
    expect(out).toContain("cmux"); // Tier 3 still rendered
    expect(out).toContain("claude");
  });
});

describe("severity rollup + remediation", () => {
  const goneCaptain: DaemonSnapshot["tier1"] = [
    { kind: "captain", project: "pact", ref: "pact-captain", state: "gone", lastSeenMs: 1 },
  ];

  it("bubbles a gone component up to its project card rollup", () => {
    const out = renderContent(full(daemon({}, goneCaptain)));
    expect(out).toMatch(/data-rollup="gone"/);
    expect(out).toContain("pact");
  });

  it("does not render relay heal commands (relay removed)", () => {
    const out = renderContent(full(daemon({}, goneCaptain)));
    expect(out).not.toContain("squadrant heal relay");
  });
});

describe("stopped distinguished from fault (#324/#323)", () => {
  const stoppedCaptain: DaemonSnapshot["tier1"] = [
    { kind: "captain", project: "pact", ref: "pact-captain", state: "stopped", lastSeenMs: null },
  ];

  it("a stopped captain rolls its project card up to 'stopped', not 'gone'", () => {
    const out = renderContent(full(daemon({}, stoppedCaptain)));
    expect(out).toMatch(/data-rollup="stopped"/);
    expect(out).not.toMatch(/data-rollup="gone"/);
  });

  it("a stopped captain does NOT trip the master CRITICAL alarm", () => {
    // A genuinely-gone captain trips CRITICAL; a stopped (intentionally closed)
    // one must not — it is an expected, calm state, not a fault.
    const out = renderContent(full(daemon({}, stoppedCaptain)));
    expect(out).not.toContain('class="annunciator a-crit');
    expect(out).not.toContain("CRITICAL");
    expect(out).toContain("stopped");
  });

  it("a stopped project's unread mail is not counted as a stale caution", () => {
    const d = daemon({}, stoppedCaptain);
    d.tier2.projects = [{
      project: "pact",
      mailbox: { maxSeq: 10, sizeBytes: 100, oldestEntryAgeMs: 60_000, rotationCount: 0 },
      delivery: { maxSeq: 10, lastAckedSeq: 2, behind: 8 },
      store: { byState: { cancelled: 2 }, corruptCount: 0 },
      deferral: { maxDeferCount: 0, stuck: false },
    }];
    const out = renderContent(full(d));
    // The card stays 'stopped' — delivery lag behind a closed captain is expected.
    expect(out).toMatch(/data-rollup="stopped"/);
  });

  it("a real fault (corrupt store) still rolls up to 'gone' even when captain is stopped", () => {
    const d = daemon({}, stoppedCaptain);
    d.tier2.projects = [{
      project: "pact",
      mailbox: { maxSeq: 10, sizeBytes: 100, oldestEntryAgeMs: 60_000, rotationCount: 0 },
      delivery: { maxSeq: 10, lastAckedSeq: 10, behind: 0 },
      store: { byState: {}, corruptCount: 1 },
      deferral: { maxDeferCount: 0, stuck: false },
    }];
    const out = renderContent(full(d));
    expect(out).toMatch(/data-rollup="gone"/);
  });
});

describe("CREW UNDELIVERED headline (B2/#466)", () => {
  const undeliveredCrew: DaemonSnapshot["tier1"] = [
    { kind: "crew", project: "pact", ref: "pact-crew-1", state: "stale", lastSeenMs: 1, detail: "undelivered (submitted)" },
  ];

  it("shows a headline banner on Overview counting undelivered crews", () => {
    const out = renderContent(full(daemon({}, undeliveredCrew)));
    expect(out).toMatch(/1 CREW UNDELIVERED/i);
  });

  it("does not show the undelivered banner when no crew is flagged", () => {
    const normalCrew: DaemonSnapshot["tier1"] = [
      { kind: "crew", project: "pact", ref: "pact-crew-1", state: "alive", lastSeenMs: 1, detail: "working" },
    ];
    const out = renderContent(full(daemon({}, normalCrew)));
    expect(out).not.toMatch(/undelivered/i);
  });

  it("Projects tab still shows the raw detail text for the flagged crew row", () => {
    const out = renderContent(full(daemon({}, undeliveredCrew)));
    expect(out).toContain("undelivered (submitted)");
  });
});

describe("delivery deferral visibility (B1/#484/#466)", () => {
  it("renders the in-flight defer count in the project's delivery block", () => {
    const d = daemon();
    d.tier2.projects[0].deferral = { maxDeferCount: 47, stuck: false };
    const out = renderContent(full(d));
    expect(out).toContain("47");
    expect(out).toMatch(/defer/i);
  });

  it("does not roll up or flag a project with zero in-flight defers", () => {
    const d = daemon();
    d.tier2.projects[0].deferral = { maxDeferCount: 0, stuck: false };
    const out = renderContent(full(d));
    expect(out).toMatch(/data-rollup="alive"/);
    expect(out).not.toMatch(/delivery stuck/i);
  });

  it("rolls a project with in-flight (but not yet stuck) defers up to 'stale'", () => {
    const d = daemon();
    d.tier2.projects[0].deferral = { maxDeferCount: 5, stuck: false };
    const out = renderContent(full(d));
    expect(out).toMatch(/data-rollup="stale"/);
  });

  it("rolls a stuck project (deferCount crossed threshold) up to 'gone' with a headline flag", () => {
    const d = daemon();
    d.tier2.projects[0].deferral = { maxDeferCount: 300, stuck: true };
    const out = renderContent(full(d));
    expect(out).toMatch(/data-rollup="gone"/);
    expect(out).toMatch(/delivery stuck/i);
  });

  it("shows the global max in-flight defer count as an Overview trend", () => {
    const d = daemon();
    d.tier2.projects[0].deferral = { maxDeferCount: 47, stuck: false };
    const out = renderContent(full(d));
    expect(out).toContain('data-spark="defers"');
    expect(out).toMatch(/Delivery defers/i);
  });

  it("a stopped captain's leftover deferral does not false-alarm (#324/#323 pattern)", () => {
    const stoppedCaptain: DaemonSnapshot["tier1"] = [
      { kind: "captain", project: "squadrant", ref: "squadrant-captain", state: "stopped", lastSeenMs: null },
    ];
    const d = daemon({}, stoppedCaptain);
    d.tier2.projects[0].deferral = { maxDeferCount: 300, stuck: true };
    const out = renderContent(full(d));
    expect(out).toMatch(/data-rollup="stopped"/);
    expect(out).not.toMatch(/data-rollup="gone"/);
  });
});

describe("delivery lag bar", () => {
  it("renders an SVG-free delivery bar with acked + behind segments", () => {
    const d = daemon();
    d.tier2.projects[0].delivery = { maxSeq: 20, lastAckedSeq: 12, behind: 8 };
    const out = renderContent(full(d));
    expect(out).toContain('class="dbar"');
    expect(out).toContain("dbar-behind");
    expect(out).toContain("8 behind");
  });
});

describe("global delivery-lag excludes offline-captain projects", () => {
  it("global behind is 0 when captain is gone (offline)", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "gone", lastSeenMs: 1 },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 5, behind: 5 };
    const out = renderContent(full(d));
    const m = out.match(/id="squadrant-metrics">(.*?)<\/script>/s);
    const metrics = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(metrics.behind).toBe(0); // captain gone → not a live delivery problem
  });
  it("global behind is 0 when captain state is unknown", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "unknown", lastSeenMs: null },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 5, behind: 5 };
    const out = renderContent(full(d));
    const m = out.match(/id="squadrant-metrics">(.*?)<\/script>/s);
    const metrics = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(metrics.behind).toBe(0); // captain unknown → excluded
  });
  it("global behind includes lag for projects whose captain is alive", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "alive", lastSeenMs: 999_000 },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 7, behind: 3 };
    const out = renderContent(full(d));
    const m = out.match(/id="squadrant-metrics">(.*?)<\/script>/s);
    const metrics = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(metrics.behind).toBe(3); // captain alive → included
  });
});

describe("idle/never-launched projects are health-neutral for the master annunciator", () => {
  it("an idle project (captain unknown) with delivery backlog does NOT trip DEGRADED", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "unknown", lastSeenMs: null },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 2, behind: 8 };
    const out = renderContent(full(d));
    expect(out).toContain('class="annunciator a-ok');
    expect(out).toContain("NOMINAL");
    expect(out).not.toContain('class="annunciator a-warn');
  });

  it("template-hash drift alone does NOT trip DEGRADED (demoted to soft/info)", () => {
    const drifted: ExternalProbes = {
      ...externalHealthy,
      config: { ...externalHealthy.config, sessions: { state: "stale", detail: "template drift: 12 distinct hashes" } },
    };
    const out = renderContent(full(daemon(), drifted));
    expect(out).toContain('class="annunciator a-ok');
    expect(out).toContain("NOMINAL");
    // the drift signal still surfaces in the Environment tab, just doesn't roll up
    expect(out).toContain("template drift: 12 distinct hashes");
  });

  it("a fleet of idle/unknown projects plus template drift together still reads NOMINAL", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "unknown", lastSeenMs: null },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 2, behind: 8 };
    const drifted: ExternalProbes = {
      ...externalHealthy,
      config: { ...externalHealthy.config, sessions: { state: "stale", detail: "template drift: 12 distinct hashes" } },
    };
    const out = renderContent(full(d, drifted));
    expect(out).toContain('class="annunciator a-ok');
    expect(out).toContain("NOMINAL");
  });

  it("delivery backlog for a genuinely ALIVE captain still trips DEGRADED (regression guard)", () => {
    const d = daemon();
    d.tier1 = [
      { kind: "captain", project: "squadrant", ref: "captain", state: "alive", lastSeenMs: 999_000 },
    ];
    d.tier2.projects[0].delivery = { maxSeq: 10, lastAckedSeq: 2, behind: 8 };
    const out = renderContent(full(d));
    expect(out).toContain('class="annunciator a-warn');
    expect(out).toContain("DEGRADED");
  });
});

describe("global results location", () => {
  it("global results line appears only in the daemon tab, not the projects tab", () => {
    const out = renderContent(full(daemon()));
    // exactly one occurrence
    const occurrences = (out.match(/global results/g) ?? []).length;
    expect(occurrences).toBe(1);
    // must be inside the daemon panel
    const daemonStart = out.indexOf('data-panel="daemon"');
    const envStart = out.indexOf('data-panel="environment"');
    const daemonSection = out.slice(daemonStart, envStart);
    expect(daemonSection).toContain("global results");
    // must NOT be inside the projects panel
    const projStart = out.indexOf('data-panel="projects"');
    const projectsSection = out.slice(projStart, daemonStart);
    expect(projectsSection).not.toContain("global results");
  });
});

describe("escaping", () => {
  it("HTML-escapes crew refs/details to prevent injection", () => {
    const evil: DaemonSnapshot["tier1"] = [
      { kind: "crew", project: "squadrant", ref: "<img src=x>", state: "alive", lastSeenMs: 999_000, detail: "working" },
    ];
    const out = renderContent(full(daemon({}, evil)));
    expect(out).not.toContain("<img src=x>");
    expect(out).toContain("&lt;img src=x&gt;");
  });
});

describe("renderTickJson", () => {
  it("returns JSON with content HTML and the generated timestamp", () => {
    const parsed = JSON.parse(renderTickJson(full(daemon())));
    expect(typeof parsed.contentHtml).toBe("string");
    expect(parsed.contentHtml).toContain("annunciator");
    expect(parsed.generatedAt).toBe(1_000_000);
  });
});
