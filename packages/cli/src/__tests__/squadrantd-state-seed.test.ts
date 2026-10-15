// #983 6a integration: the daemon boots on a fresh state root, and on a home
// that only has pre-move (~/.config/squadrant/state) data — after the boot-time
// seed copy the daemon sees the legacy task records, and the legacy dir is left
// untouched. Temp dirs only; never the real home.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStateFromLegacy } from "@squadrant/shared";
import { sendRequest } from "@squadrant/core";
import { startSquadrantd } from "../squadrantd.js";

const record = {
  id: "task-legacy", project: "demo", provider: "claude" as const, mode: "interactive" as const,
  state: "working" as const, task: "pre-move task", createdAt: 1, lastHeartbeat: 1,
  lastEvent: "", heartbeatBudgetMs: 1000,
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
};

describe("squadrantd state root move (#983 6a)", () => {
  let stop: (() => Promise<void>) | undefined;
  let dir: string;
  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("boots on a fresh home: nothing to seed, empty store", async () => {
    dir = mkdtempSync(join(tmpdir(), "state-seed-fresh-"));
    const root = join(dir, "local-state");
    expect(seedStateFromLegacy({ root, legacy: join(dir, "config-state") }).seeded).toBe(false);

    const sock = join(dir, "c.sock");
    stop = startSquadrantd({ stateRoot: root, sockPath: sock, sweepMs: 0, rotationIntervalMs: 0 }).stop;
    expect(await sendRequest(sock, { kind: "list", project: "demo" })).toEqual([]);
  });

  it("boots on a legacy-only home: seeded records are visible, legacy kept", async () => {
    dir = mkdtempSync(join(tmpdir(), "state-seed-legacy-"));
    const legacy = join(dir, "config-state");
    const root = join(dir, "local-state");

    // A pre-move daemon wrote its store under the legacy dir.
    const oldSock = join(dir, "old.sock");
    const old = startSquadrantd({ stateRoot: legacy, sockPath: oldSock, sweepMs: 0, rotationIntervalMs: 0 });
    await sendRequest(oldSock, { kind: "seed", record });
    await old.stop();
    const legacyEntries = readdirSync(legacy).sort();

    expect(seedStateFromLegacy({ root, legacy }).seeded).toBe(true);

    const sock = join(dir, "c.sock");
    stop = startSquadrantd({ stateRoot: root, sockPath: sock, sweepMs: 0, rotationIntervalMs: 0 }).stop;
    const tasks = await sendRequest(sock, { kind: "list", project: "demo" }) as Array<{ id: string }>;
    expect(tasks.map((t) => t.id)).toEqual(["task-legacy"]);

    expect(readdirSync(legacy).sort()).toEqual(legacyEntries);
    expect(existsSync(join(root, ".seeded-from-legacy"))).toBe(true);
  });
});
