// #983 6a integration: the daemon boots on a fresh state root, and on a home
// that only has pre-move (~/.config/squadrant/state) data — after the boot-time
// seed copy the daemon sees the legacy task records, and the legacy dir is left
// untouched. Temp dirs only; never the real home.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Review fix: a daemon that is about to refuse (worktree / un-opted checkout /
// live socket) must never seed — it would write the marker while the old
// daemon keeps writing the legacy dir, and the real upgraded daemon would then
// skip the copy. A real refused boot can't run under vitest (process.exit, real
// socket), so pin the ordering structurally.
describe("legacy seed ordering in squadrantd.ts (#983 6a)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "squadrantd.ts"), "utf8");

  it("startSquadrantd seeds only after every checkout/worktree refusal, before buildContext", () => {
    const fnStart = src.indexOf("export function startSquadrantd(");
    const seedAt = src.indexOf("seedStateFromLegacy()", fnStart);
    const lastRefusal = src.lastIndexOf("refusing to start", src.indexOf("const ctx = buildContext(opts);", fnStart));
    expect(fnStart).toBeGreaterThan(-1);
    expect(lastRefusal).toBeGreaterThan(fnStart);
    expect(seedAt).toBeGreaterThan(lastRefusal);
    expect(seedAt).toBeLessThan(src.indexOf("const ctx = buildContext(opts);", fnStart));
    // exactly one seed call site, so the entry block can't seed before its own guards
    expect(src.split("seedStateFromLegacy()").length - 1).toBe(1);
  });

  it("the entry block's live-socket refusal runs before startSquadrantd is called", () => {
    const liveGuard = src.indexOf("refusing to start: a live daemon already owns");
    const entryCall = src.indexOf("const h = startSquadrantd(");
    expect(liveGuard).toBeGreaterThan(-1);
    expect(entryCall).toBeGreaterThan(liveGuard);
  });
});
