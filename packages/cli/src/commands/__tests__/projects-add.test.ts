import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #983 6b: `projects add` no longer scaffolds an Obsidian spoke vault; it
// creates the exchange dirs under workspace/<p>/ instead.
const state = vi.hoisted(() => ({ hub: "", saved: null as unknown }));
vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return {
    ...actual,
    loadConfig: () => ({ hubVault: state.hub, projects: {} }),
    saveConfig: (c: unknown) => { state.saved = c; },
  };
});
vi.mock("@squadrant/core", () => ({ restartDaemonIfRunning: () => "skipped-opt-out" }));

describe("projects add (#983)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-projects-add-"));
    state.hub = path.join(tmp, "hub");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates workspace/<p>/ and no spoke vault, status.md or Obsidian scaffold", async () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const { projectsCommand } = await import("../projects.js");

    await projectsCommand.parseAsync(["node", "projects", "add", "demo", repo, "--no-restart"]);

    expect(fs.existsSync(state.hub)).toBe(false);
    const ws = path.join(process.env.SQUADRANT_WORKSPACE_DIR!, "demo");
    expect(fs.readdirSync(ws).sort()).toEqual(["artifacts", "handoffs", "inbox", "side-handoffs"]);
    // spokeVault stays in the entry as a deprecated alias (learnings/wiki until phase 4b).
    const saved = state.saved as { projects: Record<string, { spokeVault: string }> };
    expect(saved.projects.demo.spokeVault).toBe(path.join(state.hub, "spokes", "demo"));
  });
});
