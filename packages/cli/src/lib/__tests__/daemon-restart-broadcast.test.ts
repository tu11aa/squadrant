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
  NOTICE_COOLDOWN_MS,
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

/** Track calls to appendCaptainMessage — used to prove the broadcast routes
 *  through the mailbox instead of driver.send. */
function makeAppendSpy(): {
  fn: (project: string, text: string) => Promise<void>;
  projects: string[];
  texts: string[];
} {
  const projects: string[] = [];
  const texts: string[] = [];
  return {
    fn: async (project, text) => {
      projects.push(project);
      texts.push(text);
    },
    projects,
    texts,
  };
}

describe("computeRestartSignature", () => {
  it("combines version and install path into a stable string", () => {
    expect(computeRestartSignature("0.14.3", "/a/squadrantd.js")).toBe(computeRestartSignature("0.14.3", "/a/squadrantd.js"));
  });

  it("differs when version differs", () => {
    expect(computeRestartSignature("0.14.3", "/a/squadrantd.js")).not.toBe(computeRestartSignature("0.14.4", "/a/squadrantd.js"));
  });

  it("differs when the install path differs", () => {
    expect(computeRestartSignature("0.14.3", "/a/squadrantd.js")).not.toBe(computeRestartSignature("0.14.3", "/b/squadrantd.js"));
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
  it("does NOT call driver.send — enqueues to mailbox instead", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent), false, spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.projects.sort()).toEqual(["a", "b"]);
    expect(spy.texts[0]).toContain("0.14.3");
  });

  it("includes the version in the notice", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent), false, spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.texts[0]).toContain("0.14.3");
  });

  it("notes a new install path when pathChanged is true", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent), true, spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.texts[0]).toContain("new install path");
  });

  it("skips an unreachable captain without throwing and still notifies the rest", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const projB = fs.mkdtempSync(path.join(dir, "projB-"));
    const config = configWithProjects({
      a: project(projA, "captain-a"),
      b: project(projB, "captain-b"),
    });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await expect(
      notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent, new Set(["captain-a"])), false, spy.fn),
    ).resolves.not.toThrow();

    expect(sent).toHaveLength(0);
    expect(spy.projects).toEqual(["b"]);
  });

  it("no-ops silently when no projects are registered", async () => {
    const config = configWithProjects({});
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();

    await notifyCaptainsOfDaemonRestart("0.14.3", config, makeDriver(sent), false, spy.fn);

    expect(sent).toHaveLength(0);
    expect(spy.projects).toHaveLength(0);
  });
});

describe("maybeBroadcastDaemonRestart", () => {
  it("broadcasts and persists on first-ever boot (no persisted signature)", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();
    const driver = makeDriver(sent);

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      installPath: "/a/squadrantd.js",
      stateRoot,
      config,
      driver,
      appendCaptainMessage: spy.fn,
    });

    expect(sent).toHaveLength(0);
    expect(spy.projects).toEqual(["a"]);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", "/a/squadrantd.js"));
  });

  it("broadcasts when the signature changed since last boot", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    writePersistedRestartSignature(stateRoot, computeRestartSignature("0.14.2", "/a/squadrantd.js"));
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();
    const driver = makeDriver(sent);

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      installPath: "/a/squadrantd.js",
      stateRoot,
      config,
      driver,
      appendCaptainMessage: spy.fn,
    });

    expect(sent).toHaveLength(0);
    expect(spy.projects).toEqual(["a"]);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", "/a/squadrantd.js"));
  });

  it("stays silent when the signature is unchanged (same-version crash-restart)", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    writePersistedRestartSignature(stateRoot, computeRestartSignature("0.14.3", "/a/squadrantd.js"));
    const sent: Array<{ captain: string; message: string }> = [];
    const spy = makeAppendSpy();
    const driver = makeDriver(sent);

    await maybeBroadcastDaemonRestart({
      version: "0.14.3",
      installPath: "/a/squadrantd.js",
      stateRoot,
      config,
      driver,
      appendCaptainMessage: spy.fn,
    });

    expect(sent).toHaveLength(0);
    expect(spy.projects).toHaveLength(0);
  });

  // 2026-10-26: eight "Daemon restarted → v0.31.1 (dev build)" notices in one morning,
  // one per same-version `npm i -g` + `heal daemon` — none was a version or path change.
  it("stays silent on a same-version, same-path reinstall (rebuild + heal daemon)", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const spy = makeAppendSpy();
    const opts = { version: "0.14.3", installPath: "/a/squadrantd.js", stateRoot, config, driver: makeDriver([]), appendCaptainMessage: spy.fn };
    await maybeBroadcastDaemonRestart({ ...opts, now: () => 0 });
    await maybeBroadcastDaemonRestart({ ...opts, now: () => 60 * 60_000 }); // rebuilt, reinstalled, healed
    expect(spy.projects).toEqual(["a"]); // first boot only
  });

  it("migrates a legacy mtime signature of the same version silently", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    writePersistedRestartSignature(stateRoot, "0.14.3::1793005507254.4949");
    const spy = makeAppendSpy();
    await maybeBroadcastDaemonRestart({ version: "0.14.3", installPath: "/a/squadrantd.js", stateRoot, config, driver: makeDriver([]), appendCaptainMessage: spy.fn });
    expect(spy.projects).toHaveLength(0);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", "/a/squadrantd.js"));
  });

  it("never notifies twice in a row within the cooldown (A→B→A flip), but records the signature", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const spy = makeAppendSpy();
    const base = { version: "0.14.3", stateRoot, config, driver: makeDriver([]), appendCaptainMessage: spy.fn };
    await maybeBroadcastDaemonRestart({ ...base, installPath: "/a/squadrantd.js", now: () => 0 });
    await maybeBroadcastDaemonRestart({ ...base, installPath: "/b/squadrantd.js", now: () => 10_000 });
    expect(spy.projects).toEqual(["a"]);
    expect(readPersistedRestartSignature(stateRoot)).toBe(computeRestartSignature("0.14.3", "/b/squadrantd.js"));
    await maybeBroadcastDaemonRestart({ ...base, version: "0.14.4", installPath: "/b/squadrantd.js", now: () => NOTICE_COOLDOWN_MS + 1 });
    expect(spy.projects).toEqual(["a", "a"]); // a real change after the cooldown notifies again
  });

  it("never throws even when the driver fails entirely", async () => {
    const projA = fs.mkdtempSync(path.join(dir, "projA-"));
    const config = configWithProjects({ a: project(projA, "captain-a") });
    const spy = makeAppendSpy();
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
        installPath: "/a/squadrantd.js",
        stateRoot,
        config,
        driver: throwingDriver,
        appendCaptainMessage: spy.fn,
      }),
    ).resolves.not.toThrow();
  });
});