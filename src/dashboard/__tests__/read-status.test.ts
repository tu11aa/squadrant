import { describe, it, expect } from "vitest";
import type { CockpitConfig } from "../../config.js";
import { parseStatusFile, readAllStatuses } from "../read-status.js";

const SAMPLE = [
  "---",
  "project: brove",
  "auto_state: idle",
  'auto_last_checked: "2026-05-05T12:00:00.000Z"',
  "captain_workspace: brove-captain",
  "---",
  "",
  "# Status (auto-derived)",
  "",
  "## Last activity excerpt",
  "",
  "```",
  "alpha",
  "│ > ",
  "```",
  "",
].join("\n");

function makeConfig(): CockpitConfig {
  return {
    commandName: "command",
    hubVault: "/tmp/hub",
    projects: {
      brove:  { path: "/tmp/brove",  captainName: "brove-captain",  spokeVault: "/tmp/spokes/brove",  host: "local" },
      solder: { path: "/tmp/solder", captainName: "solder-captain", spokeVault: "/tmp/spokes/solder", host: "local" },
    },
    defaults: { maxCrew: 5, worktreeDir: ".worktrees", teammateMode: "in-process", permissions: { command: "auto", captain: "auto" } },
    metrics: { enabled: false, path: "" },
  };
}

describe("parseStatusFile", () => {
  it("extracts frontmatter + excerpt", () => {
    const out = parseStatusFile(SAMPLE);
    expect(out).toEqual({
      project: "brove",
      state: "idle",
      lastChecked: "2026-05-05T12:00:00.000Z",
      captainWorkspace: "brove-captain",
      excerpt: "alpha\n│ > ",
    });
  });

  it("strips quotes around frontmatter values", () => {
    const text = SAMPLE.replace("captain_workspace: brove-captain", 'captain_workspace: "brove-captain"');
    expect(parseStatusFile(text)?.captainWorkspace).toBe("brove-captain");
  });

  it("returns null when the file has no frontmatter", () => {
    expect(parseStatusFile("# random\nno fm here\n")).toBeNull();
  });

  it("falls back to empty excerpt when no fenced block", () => {
    const text = [
      "---",
      "project: x",
      "auto_state: busy",
      'auto_last_checked: "2026-05-05T12:00:00.000Z"',
      "captain_workspace: x-captain",
      "---",
      "",
      "no excerpt here",
    ].join("\n");
    expect(parseStatusFile(text)?.excerpt).toBe("");
  });

  it("treats unknown auto_state as 'unknown'", () => {
    const text = SAMPLE.replace("auto_state: idle", "auto_state: weird-value");
    expect(parseStatusFile(text)?.state).toBe("unknown");
  });
});

describe("readAllStatuses", () => {
  it("returns one row per registered project", () => {
    const reads: string[] = [];
    const readFile = (p: string) => {
      reads.push(p);
      if (p.includes("brove"))  return SAMPLE;
      if (p.includes("solder")) return SAMPLE.replace("project: brove", "project: solder")
                                            .replace("auto_state: idle", "auto_state: busy")
                                            .replace("brove-captain", "solder-captain");
      throw new Error("not found");
    };

    const rows = readAllStatuses({ config: makeConfig(), readFile });

    expect(rows.map((r) => r.project)).toEqual(["brove", "solder"]);
    expect(rows[0].state).toBe("idle");
    expect(rows[1].state).toBe("busy");
    expect(reads).toEqual(["/tmp/spokes/brove/status.md", "/tmp/spokes/solder/status.md"]);
  });

  it("yields state='unknown' when status.md is missing", () => {
    const readFile = () => { throw new Error("ENOENT"); };
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("unknown");
    expect(rows[0].lastChecked).toBe("");
  });

  it("yields state='unknown' when status.md has no parseable frontmatter", () => {
    const readFile = () => "# garbage\n";
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows[0].state).toBe("unknown");
  });

  it("preserves the project name from config even when the file uses a different one", () => {
    const readFile = () => SAMPLE; // file says project: brove for both reads
    const rows = readAllStatuses({ config: makeConfig(), readFile });
    expect(rows[0].project).toBe("brove");
    expect(rows[1].project).toBe("solder");
  });
});
