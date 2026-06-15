import { describe, it, expect } from "vitest";
import { renderHtml, renderContent, renderTickJson } from "../web-render.js";
import type { FullSnapshot } from "../snapshot-merge.js";
import type { DaemonSnapshot } from "../../control/snapshot.js";
import type { ExternalProbes } from "../probes.js";

const externalHealthy: ExternalProbes = {
  cmux: { state: "alive" },
  agentClis: [
    { cli: "claude", state: "alive" },
    { cli: "codex", state: "alive" },
    { cli: "gemini", state: "alive" },
    { cli: "opencode", state: "alive" },
  ],
  vaults: { hub: { path: "/h", state: "alive" }, spokes: [{ project: "cockpit", path: "/s", state: "alive" }] },
  config: { parseable: { state: "alive" }, projectPaths: [{ project: "cockpit", path: "/r", state: "alive" }], sessions: { state: "alive" } },
};

function daemon(over: Partial<DaemonSnapshot["tier0"]> = {}, tier1: DaemonSnapshot["tier1"] = []): DaemonSnapshot {
  return {
    tier0: {
      pid: 4821, uptimeMs: 6 * 3600_000, version: "0.6.1",
      build: { state: "fresh", processStartedAt: 2000, distBuiltAt: 1000 },
      sweep: { lastSweepAt: 1000, ageMs: 8000, cadenceMs: 30_000 },
      log: { errorCount: 0, sizeBytes: 100, windowMs: 3_600_000 },
      ...over,
    },
    tier1,
    tier2: {
      projects: [
        {
          project: "cockpit",
          mailbox: { maxSeq: 12, sizeBytes: 1300, oldestEntryAgeMs: 60_000, rotationCount: 0 },
          delivery: { maxSeq: 12, lastAckedSeq: 12, behind: 0 },
          store: { byState: { working: 3, blocked: 1 }, corruptCount: 0 },
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
    expect(html).toContain("COCKPIT SYSTEM HEALTH");
    expect(html).toContain('id="content"');
    expect(html).toContain('id="conn"');
    expect(html).toContain("EventSource"); // bootstrap JS wires the SSE stream
  });
});

describe("stale-build banner", () => {
  it("renders the loud banner only when the build is stale", () => {
    const stale = renderContent(full(daemon({ build: { state: "stale", processStartedAt: 1000, distBuiltAt: 9999 } })));
    expect(stale).toContain("DAEMON RUNNING STALE CODE");
    // remediation is copy-able text, not a button
    expect(stale).toContain("npm run build");
    expect(stale).not.toContain("<button");
  });
  it("omits the banner when the build is fresh", () => {
    expect(renderContent(full(daemon()))).not.toContain("DAEMON RUNNING STALE CODE");
  });
});

describe("daemon unreachable", () => {
  it("shows the unreachable banner but still renders Tier 3/4", () => {
    const out = renderContent(full("unreachable"));
    expect(out).toContain("DAEMON UNREACHABLE");
    expect(out).toContain("cmux"); // Tier 3 still rendered
    expect(out).toContain("claude");
  });
});

describe("severity rollup + remediation", () => {
  const goneRelay: DaemonSnapshot["tier1"] = [
    { kind: "relay", project: "pact", ref: "relay", state: "gone", lastSeenMs: 1, detail: "relay DOWN" },
    { kind: "captain", project: "pact", ref: "pact-captain", state: "gone", lastSeenMs: 1 },
  ];

  it("bubbles a gone component up to its project header rollup", () => {
    const out = renderContent(full(daemon({}, goneRelay)));
    expect(out).toMatch(/data-rollup="gone"[^>]*>[^<]*pact/);
  });

  it("renders the heal command as copy-able remediation under the gone relay", () => {
    const out = renderContent(full(daemon({}, goneRelay)));
    expect(out).toContain("cockpit heal relay --project pact");
  });

  it("does not render remediation for healthy components", () => {
    const aliveRelay: DaemonSnapshot["tier1"] = [
      { kind: "relay", project: "cockpit", ref: "relay", state: "alive", lastSeenMs: 999_000 },
    ];
    expect(renderContent(full(daemon({}, aliveRelay)))).not.toContain("cockpit heal relay");
  });
});

describe("escaping", () => {
  it("HTML-escapes crew refs/details to prevent injection", () => {
    const evil: DaemonSnapshot["tier1"] = [
      { kind: "crew", project: "cockpit", ref: "<img src=x>", state: "alive", lastSeenMs: 999_000, detail: "working" },
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
    expect(parsed.contentHtml).toContain("COCKPIT SYSTEM HEALTH");
    expect(parsed.generatedAt).toBe(1_000_000);
  });
});
