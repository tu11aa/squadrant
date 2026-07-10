// Unit tests for launchOneWorkspace's --keep semantics (#534).
// Uses real fs on a temp dir (mirrors session-freshness.test.ts) plus a
// minimal RuntimeDriver mock — no real processes or cmux.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RuntimeDriver } from "@squadrant/shared";
import { launchOneWorkspace } from "../launch-workspace.js";
import { saveSessions, computeTemplateHash } from "../session-freshness.js";

let tmpDir: string;
let sessionsPath: string;
let templatesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-lw-test-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
  templatesDir = path.join(tmpDir, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(): RuntimeDriver {
  return {
    name: "mock",
    probe: vi.fn(),
    list: vi.fn(),
    status: vi.fn().mockResolvedValue(null),
    spawn: vi.fn().mockResolvedValue({ id: "workspace:1", name: "ws", status: "running" }),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn(),
    stop: vi.fn(),
    newPane: vi.fn(),
    closePane: vi.fn(),
    sendToPane: vi.fn(),
    pasteToPane: vi.fn(),
    sendKeyToPane: vi.fn(),
    readPaneScreen: vi.fn(),
    listSurfaces: vi.fn(),
    spawnInjector: vi.fn(),
  } as unknown as RuntimeDriver;
}

describe("launchOneWorkspace --keep (#534)", () => {
  it("resumes (no forceFresh) when keepOverride overrides a 'new day' reason", async () => {
    const hash = computeTemplateHash("captain", templatesDir);
    saveSessions(sessionsPath, { workspaces: { "ws-1": { lastLaunched: "2000-01-01", templateHash: hash } } });

    const agentCmdFactory = vi.fn().mockReturnValue("claude-cli");
    const onFreshReason = vi.fn();

    await launchOneWorkspace({
      workspaceName: "ws-1",
      role: "captain",
      cwd: tmpDir,
      keepOverride: true,
      sessionsPath,
      templatesDir,
      agentCmdFactory,
      runtime: makeRuntime(),
      onFreshReason,
    });

    expect(agentCmdFactory).toHaveBeenCalledWith(false);
    expect(onFreshReason).toHaveBeenCalledWith(
      expect.stringContaining("keeping previous session (--keep)"),
    );
  });

  it("still starts fresh on a genuine first launch even with keepOverride (nothing to resume)", async () => {
    const agentCmdFactory = vi.fn().mockReturnValue("claude-cli");
    const onFreshReason = vi.fn();

    await launchOneWorkspace({
      workspaceName: "ws-new",
      role: "captain",
      cwd: tmpDir,
      keepOverride: true,
      sessionsPath,
      templatesDir,
      agentCmdFactory,
      runtime: makeRuntime(),
      onFreshReason,
    });

    expect(agentCmdFactory).toHaveBeenCalledWith(true);
    expect(onFreshReason).toHaveBeenCalledWith("first launch");
  });
});
