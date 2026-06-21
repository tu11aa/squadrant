#!/usr/bin/env node
// Daemon-level smoke for the claude interactive control-plane wiring.
//
// Runs against a PRIVATE temp-socket squadrantd started from the freshly-built
// dist code in this branch — does NOT touch the shared system daemon (which
// has other captains' tasks in flight; cannot bounce). Does NOT spawn a real
// Claude process either (the smoke runner is itself a squadrant crew — no
// nested crew spawns). Posts the same socket frames that runCrewSpawn would
// post for a real Claude crew and verifies state transitions end-to-end.
//
// Invocation: node scripts/claude-iv-smoke.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { startSquadrantd } from "../dist/control/squadrantd.js";

const PROJECT = "smoke";
const tmp = mkdtempSync(join(tmpdir(), "claude-iv-smoke-"));
const SOCK = join(tmp, "c.sock");
const h = startSquadrantd({ stateRoot: join(tmp, "state"), sockPath: SOCK, sweepMs: 0 });

function rpc(req) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCK);
    let buf = "";
    conn.setEncoding("utf-8");
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (c) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      conn.end();
      try {
        const m = JSON.parse(line);
        if (m.ok) resolve(m.reply);
        else reject(new Error(m.error));
      } catch (e) { reject(e); }
    });
    conn.on("error", reject);
  });
}

async function step(label, fn) {
  process.stdout.write(`\n--- ${label} ---\n`);
  const r = await fn();
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  return r;
}

async function main() {
  const taskId = randomUUID();
  const now = Date.now();

  // 1. Dispatch — daemon stores submitted, launchInteractive emits task.started.
  const dispatched = await step("1. dispatch claude interactive", () =>
    rpc({
      kind: "dispatch",
      record: {
        id: taskId,
        project: PROJECT,
        provider: "claude",
        mode: "interactive",
        state: "submitted",
        task: "smoke test — verify the daemon wires for claude interactive",
        cwd: "/Users/q3labsadmin/me/claude-cockpit",
        createdAt: now,
        lastHeartbeat: now,
        lastEvent: "dispatch",
        heartbeatBudgetMs: 60000,
        attempts: [{ attemptId: randomUUID(), startedAt: now, lastHeartbeatAt: now }],
      },
    }),
  );
  if (dispatched.state !== "submitted")
    throw new Error(`expected state=submitted at dispatch ack, got ${dispatched.state}`);

  // Brief settle for the async task.started emit.
  await new Promise((r) => setTimeout(r, 50));

  // 2. Status should show working now (task.started landed).
  const afterStart = await step("2. status after launchInteractive emits task.started", () =>
    rpc({ kind: "status", project: PROJECT, id: taskId }),
  );
  if (afterStart.state !== "working")
    throw new Error(`expected state=working after task.started, got ${afterStart.state}`);

  // 3. Simulate Stop hook → task.progress (liveness only — anti-#2576).
  const afterProgress = await step("3. POST task.progress (simulating Stop hook from cmux tab)", () =>
    rpc({
      kind: "event",
      project: PROJECT,
      event: { type: "task.progress", id: taskId, note: "stop" },
    }),
  );
  if (afterProgress.state !== "working")
    throw new Error(`bare Stop hook MUST NOT advance state (anti-#2576). Got: ${afterProgress.state}`);
  if (afterProgress.lastEvent !== "task.progress")
    throw new Error(`expected lastEvent=task.progress, got ${afterProgress.lastEvent}`);

  // 4. Simulate explicit `squadrant crew signal done` → task.done with resultRef.
  const afterDone = await step("4. POST task.done (simulating 'squadrant crew signal done')", () =>
    rpc({
      kind: "event",
      project: PROJECT,
      event: { type: "task.done", id: taskId, resultRef: "/tmp/smoke-result.txt" },
    }),
  );
  if (afterDone.state !== "done")
    throw new Error(`expected state=done after explicit signal, got ${afterDone.state}`);

  // 5. Status read confirms terminal state without any pane scrape.
  const final = await step("5. status read — captain learns 'done' WITHOUT scraping", () =>
    rpc({ kind: "status", project: PROJECT, id: taskId }),
  );
  if (final.state !== "done")
    throw new Error(`final read mismatch: ${final.state}`);
  if (final.resultRef !== "/tmp/smoke-result.txt")
    throw new Error(`final resultRef mismatch: ${final.resultRef}`);

  process.stdout.write("\n✔ ALL ASSERTIONS PASSED — claude interactive control-plane wiring works end-to-end.\n");
  process.stdout.write(`  taskId: ${taskId}\n`);
}

main()
  .then(() => { h.stop(); rmSync(tmp, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => {
    process.stderr.write(`✘ SMOKE FAILED: ${e.message}\n`);
    try { h.stop(); rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(1);
  });
