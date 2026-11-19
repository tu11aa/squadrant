import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
import { runDaemonUpdateCheck, shouldPushUpdate, readNotifiedVersion } from "../daemon-update-notice.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-update-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(doc: unknown, config = (() => { const c = getDefaultConfig(); c.projects = { p1: { path: "/x", captainName: "cap1", spokeVault: "", host: "" } }; return c; })()) {
  const sent: string[] = [];
  const base = {
    version: "0.38.0",
    stateRoot: path.join(dir, "state"),
    config,
    driver: { status: async (n: string) => ({ id: n }) },
    appendCaptainMessage: async (_p: string, t: string) => { sent.push(t); },
    fetchImpl: async () => doc,
    statePath: path.join(dir, "update-check.json"),
  };
  return { sent, base };
}

describe("shouldPushUpdate", () => {
  it("only for important or below-minSafe, and only when newer", () => {
    expect(shouldPushUpdate({ latestKnown: "0.39.0" }, "0.38.0")).toBe(false);
    expect(shouldPushUpdate({ latestKnown: "0.39.0", level: "important" }, "0.38.0")).toBe(true);
    expect(shouldPushUpdate({ latestKnown: "0.39.0", minSafe: "0.38.5" }, "0.38.0")).toBe(true);
    expect(shouldPushUpdate({ latestKnown: "0.38.0", level: "important" }, "0.38.0")).toBe(false);
  });
});

describe("runDaemonUpdateCheck", () => {
  it("notifies live captains once per important version, not again after a restart", async () => {
    const { sent, base } = setup({ version: "0.39.0", squadrantUpdate: { level: "important", reason: "fix" } });
    await runDaemonUpdateCheck({ ...base, now: () => 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/IMPORTANT.*0.39.0.*fix/);
    expect(readNotifiedVersion(base.stateRoot)).toBe("0.39.0");
    // daemon restart: fresh process, even with a stale cache forcing a refetch
    await runDaemonUpdateCheck({ ...base, now: () => 10 * 24 * 3600 * 1000 });
    expect(sent).toHaveLength(1);
  });

  it("does not use up the notice when no captain is live; delivers once when one is", async () => {
    const { sent, base } = setup({ version: "0.39.0", squadrantUpdate: { level: "important" } });
    let live = false;
    const driver = { status: async (n: string) => (live ? { id: n } : null) };
    await runDaemonUpdateCheck({ ...base, driver, now: () => 1 });
    expect(sent).toEqual([]);
    expect(readNotifiedVersion(base.stateRoot)).toBeNull();
    live = true;
    await runDaemonUpdateCheck({ ...base, driver, now: () => 2 });
    expect(sent).toHaveLength(1);
    expect(readNotifiedVersion(base.stateRoot)).toBe("0.39.0");
    await runDaemonUpdateCheck({ ...base, driver, now: () => 3 });
    expect(sent).toHaveLength(1);
  });

  it("notifies again for a newer important version", async () => {
    const { sent, base } = setup({ version: "0.39.0", squadrantUpdate: { level: "important" } });
    await runDaemonUpdateCheck({ ...base, now: () => 1 });
    await runDaemonUpdateCheck({ ...base, fetchImpl: async () => ({ version: "0.40.0", squadrantUpdate: { level: "important" } }), now: () => 10 * 24 * 3600 * 1000 });
    expect(sent).toHaveLength(2);
  });

  it("stays silent for a normal release", async () => {
    const { sent, base } = setup({ version: "0.39.0" });
    await runDaemonUpdateCheck({ ...base, now: () => 1 });
    expect(sent).toEqual([]);
  });

  it("respects the opt-out", async () => {
    const c = getDefaultConfig();
    c.projects = { p1: { path: "/x", captainName: "cap1", spokeVault: "", host: "" } };
    c.defaults = { ...c.defaults, updateCheck: false };
    const { sent, base } = setup({ version: "0.39.0", squadrantUpdate: { level: "important" } }, c);
    await runDaemonUpdateCheck({ ...base, now: () => 1 });
    expect(sent).toEqual([]);
  });
});
