import { describe, it, expect, beforeEach } from "vitest";
import type { CockpitConfig } from "@cockpit/shared";
import type { ProjectStatus } from "../read-status.js";
import { syncHub, buildMirrorMarkdown } from "../sync-hub.js";

function makeConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove:  { path: "/tmp/brove",  captainName: "brove-captain",  spokeVault: "/tmp/spokes/brove",  host: "local" },
      solder: { path: "/tmp/solder", captainName: "solder-captain", spokeVault: "/tmp/spokes/solder", host: "local" },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
    ...overrides,
  } as CockpitConfig;
}

const STATUSES: ProjectStatus[] = [
  { project: "brove",  state: "idle", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain",  excerpt: "alpha\n│ > " },
  { project: "solder", state: "busy", lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "solder-captain", excerpt: "✻ Cogitating" },
];

describe("buildMirrorMarkdown", () => {
  it("emits dataview-readable frontmatter + excerpt", () => {
    const out = buildMirrorMarkdown(STATUSES[0]);
    expect(out).toMatch(/^---$/m);
    expect(out).toContain("project: brove");
    expect(out).toContain("auto_state: idle");
    expect(out).toContain('auto_last_checked: "2026-05-05T12:00:00.000Z"');
    expect(out).toContain("captain_workspace: brove-captain");
    expect(out).toContain("## Last activity excerpt");
    expect(out).toMatch(/```\nalpha\n│ > \n```/);
  });

  it("emits frontmatter even when excerpt is empty", () => {
    const out = buildMirrorMarkdown({ ...STATUSES[0], excerpt: "" });
    expect(out).toContain("auto_state: idle");
    expect(out).toMatch(/```\n\n```/);
  });
});

describe("syncHub", () => {
  let writes: Array<{ path: string; content: string }>;
  let mkdirs: string[];

  beforeEach(() => {
    writes = [];
    mkdirs = [];
  });

  it("writes one mirror file per status row to {hubVault}/projects/<name>.md", () => {
    const result = syncHub({
      config: makeConfig(),
      statuses: STATUSES,
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(writes.map((w) => w.path)).toEqual([
      "/tmp/hub/projects/brove.md",
      "/tmp/hub/projects/solder.md",
    ]);
    expect(mkdirs).toContain("/tmp/hub/projects");
    expect(result).toEqual([
      { project: "brove",  hubPath: "/tmp/hub/projects/brove.md" },
      { project: "solder", hubPath: "/tmp/hub/projects/solder.md" },
    ]);
  });

  it("returns [] and writes nothing when hubVault is empty", () => {
    const result = syncHub({
      config: makeConfig({ hubVault: "" }),
      statuses: STATUSES,
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });

    expect(result).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("expands ~ in hubVault", () => {
    const home = process.env.HOME ?? "/home";
    syncHub({
      config: makeConfig({ hubVault: "~/cockpit-hub" }),
      statuses: [STATUSES[0]],
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: (p) => { mkdirs.push(p); },
    });
    expect(writes[0].path).toBe(`${home}/cockpit-hub/projects/brove.md`);
  });

  it("skips status rows with state='unknown' (no data, don't churn the mirror)", () => {
    const result = syncHub({
      config: makeConfig(),
      statuses: [{ ...STATUSES[0], state: "unknown" }],
      writeFile: (p, c) => { writes.push({ path: p, content: c }); },
      mkdir: () => {},
    });
    expect(result).toEqual([]);
    expect(writes).toEqual([]);
  });
});
