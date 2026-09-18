import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, saveConfig } from "@squadrant/shared";
import { writeCaptainAddress } from "@squadrant/core";
import { runWhoami, formatWhoami, buildWhoamiDeps } from "../whoami.js";

let dir: string;
let cfgPath: string;
let stateRoot: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-whoami-"));
  cfgPath = path.join(dir, "config.json");
  stateRoot = path.join(dir, "state");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function registerProject(configRoot: string, name: string, projectPath: string) {
  const config = getDefaultConfig();
  config.projects[name] = {
    path: projectPath,
    captainName: `⚓ ${name}-captain`,
    spokeVault: path.join(configRoot, "spoke"),
    host: "",
  };
  saveConfig(config, cfgPath);
}

describe("runWhoami — real file wiring (integration)", () => {
  it("resolves an opencode captain from its captain record", () => {
    const projPath = path.join(dir, "proj-squadrant");
    fs.mkdirSync(projPath, { recursive: true });
    registerProject(dir, "squadrant", projPath);
    writeCaptainAddress(stateRoot, "squadrant", {
      agent: "opencode",
      port: 49526,
      sessionId: "ses_abc",
      directory: projPath,
      launchedAt: new Date().toISOString(),
    });

    const result = runWhoami({
      configPath: cfgPath,
      stateRoot,
      cwd: projPath,
      env: { SQUADRANT_ROLE: "captain" },
      readClaudeBySocket: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      project: "squadrant",
      role: "captain",
      agent: "opencode",
      sessionId: "ses_abc",
      address: "http://127.0.0.1:49526",
      source: "captain-record",
    });
  });

  it("resolves an opencode crew from its task record", () => {
    const projPath = path.join(dir, "proj-crew");
    fs.mkdirSync(projPath, { recursive: true });
    registerProject(dir, "crewproj", projPath);
    fs.mkdirSync(path.join(stateRoot, "crewproj"), { recursive: true });
    fs.writeFileSync(
      path.join(stateRoot, "crewproj", "t1.json"),
      JSON.stringify({ id: "t1", project: "crewproj", provider: "opencode", state: "working",
        sessionId: "ses_crew", serverPort: 51000, cwd: projPath, task: "x", mode: "interactive",
        lastHeartbeat: 0, lastEvent: "x", heartbeatBudgetMs: 1, attempts: [], createdAt: 0 }),
    );

    const result = runWhoami({
      configPath: cfgPath,
      stateRoot,
      cwd: projPath,
      env: { SQUADRANT_CREW_TASK_ID: "t1", SQUADRANT_CREW_PROJECT: "crewproj" },
      readClaudeBySocket: () => undefined,
    });

    expect(result.record).toMatchObject({
      project: "crewproj",
      role: "crew",
      agent: "opencode",
      sessionId: "ses_crew",
      address: "http://127.0.0.1:51000",
      source: "task-record",
    });
  });

  it("exits non-resolved (ok:false) when nothing identifies the caller", () => {
    registerProject(dir, "squadrant", path.join(dir, "nope"));
    const result = runWhoami({
      configPath: cfgPath,
      stateRoot,
      cwd: path.join(dir, "elsewhere"),
      env: {},
      readClaudeBySocket: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.record.source).toBe("none");
  });

  it("buildWhoamiDeps sources projects from config (realpath-normalized)", () => {
    const projPath = path.join(dir, "proj-x");
    fs.mkdirSync(projPath, { recursive: true });
    registerProject(dir, "x", projPath);
    const deps = buildWhoamiDeps({ configPath: cfgPath, stateRoot });
    // macOS canonicalizes /var → /private/var; the match must be symlink-safe.
    expect(deps.projects.x).toBe(fs.realpathSync(projPath));
  });
});

describe("formatWhoami", () => {
  it("renders nulls as dashes and includes the source", () => {
    const out = formatWhoami({
      ok: true,
      record: { project: null, role: "captain", agent: null, sessionId: null,
        address: null, source: "captain-record", note: "hi" },
    });
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
    expect(out).toContain("captain-record");
    expect(out).toContain("hi");
  });
});
