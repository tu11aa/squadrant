import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
import type { SquadrantConfig, ProjectConfig } from "@squadrant/shared";
import {
  computeRestartSignature,
  readPersistedRestartSignature,
  writePersistedRestartSignature,
  notifyCaptainsOfDaemonRestart,
  maybeBroadcastDaemonRestart,
} from "../daemon-restart-broadcast.js";

let dir: string;
let stateRoot: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-restart-broadcast-"));
  stateRoot = path.join(dir, "state");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function project(p: string, captainName: string): ProjectConfig {
  return { path: p, captainName, spokeVault: "", host: "" };
}

function configWithProjects(projects: Record<string, ProjectConfig>): SquadrantConfig {
  const config = getDefaultConfig();
  config.projects = projects;
  return config;
}

function makeDriver(sent: Array<{ captain: string; message: string }>, failing = new Set<string>()) {
  return {
    async status(name: string) {
      if (failing.has(name)) throw new Error(`unreachable: ${name}`);
      return { id: name };
    },
    async send(ref: string, message: string) {
      sent.push({ captain: ref, message });
    },
  };
}

describe("computeRestartSignature", () => {
  it("combines version and build mtime into a stable string", () => {
    expect(computeRestartSignature("0.14.3", 1000)).toBe(computeRestartSignature("0.14.3", 1000));
  });

  it("differs when version differs", () => {
    expect(computeRestartSignature("0.14.3", 1000)).not.toBe(computeRestartSignature("0.14.4", 1000));
  });

  it("differs when build mtime differs", () => {
    expect(computeRestartSignature("0.14.3", 1000)).not.toBe(computeRestartSignature("0.14.3", 2000));
  });
});

describe("persisted restart signature", () => {
  it("returns null when nothing is persisted yet", () => {
    expect(readPersistedRestartSignature(stateRoot)).toBeNull();
  });

  it("round-trips a written signature", () => {
    writePersistedRestartSignature(stateRoot, "0.14.3::1000");
    expect(readPersistedRestartSignature(stateRoot)).toBe("0.14.3::1000");
  });

  it("overwrites a previously persisted signature", () => {
    writePersistedRestartSignature(stateRoot, "0.14.3::1000");
    writePersistedRestartSignature(stateRoot, "0.14.4::2000");
    expect(readPersistedRestartSignature(stateRoot)).toBe("0.14.4::2000");
  });
});

describe("notifyCaptainsOfDaemonRestart", () => {
  it("notifies every running captain, with no self-exclusion", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent));

    expect(sent.map((s) => s.captain).sort()).toEqual(["captain-a", "captain-b"]);
  });

  it("includes the version in the notice", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent));

    expect(sent[0].message).toContain("0.14.3");
  });

  it("notes a dev build when isDevRebuild is true", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent), true);

    expect(sent[0].message).toContain("dev build");
  });

  it("skips an unreachable captain without throwing and still notifies the rest", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];

    await expect(
      notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent, new Set(["captain-a"]))),
    ).resolves.not.toThrow();

    expect(sent.map((s) => s.captain)).toEqual(["captain-b"]);
  });

  it("no-ops silently when no projects are registered", async () => {
    const config = configWithProjects({});
    const sent: Array<{ captain: string; message: string }> = [];

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent));

    expect(sent).toHaveLength(0);
  });
});

describe("maybeBroadcastDaemonRestart", () => {
  it("broadcasts and persists on first-ever boot (no persisted signature)", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      buildMtimeMs: 1000,
      stateRoot,
      config,
      driver: makeDriver(sent),
    });

    expect(sent).toHaveLength(1);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", 1000));
  });

  it("broadcasts when the signature changed since last boot", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    writePersistedRestartSignature(stateRoot, computeRestartSignature("0.14.2", 500));
    const sent: Array<{ captain: string; message: string }> = [];

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      buildMtimeMs: 1000,
      stateRoot,
      config,
      driver: makeDriver(sent),
    });

    expect(sent).toHaveLength(1);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", 1000));
  });

  it("stays silent when the signature is unchanged (same-version crash-restart)", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    writePersistedRestartSignature(stateRoot, computeRestartSignature("0.14.3", 1000));
    const sent: Array<{ captain: string; message: string }> = [];

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      buildMtimeMs: 1000,
      stateRoot,
      config,
      driver: makeDriver(sent),
    });

    expect(sent).toHaveLength(0);
  });

  it("never throws even when the driver fails entirely", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const throwingDriver = {
      async status(): Promise<{ id: string } | null> {
        throw new Error("boom");
      },
      async send(): Promise<void> {
        throw new Error("boom");
      },
    };

    await expect(
      maybeBroadcastDaemonRestart({
        version: "0.14.3",
        buildMtimeMs: 1000,
        stateRoot,
        config,
        driver: throwingDriver,
      }),
    ).resolves.not.toThrow();
  });
});
