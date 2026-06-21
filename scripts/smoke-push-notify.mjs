#!/usr/bin/env node
// scripts/smoke-push-notify.mjs
//
// Live(ish) smoke for #109: spins up a real squadrantd from the worktree
// dist on a temp socket, injects a capturing `notify`, seeds a task, then
// drives the same control events that `squadrant crew signal done|blocked|
// failed` would emit. Asserts that each terminal/attention transition
// produced exactly one captain-bound notification with the spec'd
// CREW … [<provider>/<taskId-8>]: … format. Also probes redundancy
// (a second done is a no-op) and notifier-down resilience (a throwing
// notify must not crash the daemon).
//
// We use `notify` capture rather than shelling out to the production
// `squadrant runtime send` because (a) the unit suite already covers the
// shell-out path, and (b) restarting the launchd-managed daemon to point
// at the worktree build would interrupt unrelated in-flight sessions
// (squadrant memory: "never auto-restart running captain/crew sessions").
// This smoke validates startSquadrantd → createDaemon → notify wiring
// end-to-end through the real socket; the shell-out is one execFileSync
// call away in the default `notify` and is covered by the cmux notifier
// tests.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const distEntry = pathToFileURL(join(__dirname, "..", "dist", "control", "squadrantd.js")).href;
const distProto = pathToFileURL(join(__dirname, "..", "dist", "control", "protocol.js")).href;
const { startSquadrantd } = await import(distEntry);
const { sendRequest } = await import(distProto);

const evidencePath = join(__dirname, "..", ".phase-3-5-smoke-evidence.local");
const log = [];
const record = (m) => { log.push(m); process.stdout.write(m + "\n"); };

const dir = mkdtempSync(join(tmpdir(), "cp-phase35-"));
const sock = join(dir, "c.sock");
const captured = []; // {project, message}

const handle = startSquadrantd({
  stateRoot: join(dir, "state"),
  sockPath: sock,
  sweepMs: 0,
  notify: (args) => { captured.push({ project: args.project, message: args.message }); },
});

const baseRec = (id, overrides = {}) => ({
  id, project: "p", provider: "claude", mode: "interactive",
  state: "submitted", task: "ship the phase 3.5 push notifications",
  createdAt: 1, lastHeartbeat: 1, lastEvent: "",
  heartbeatBudgetMs: 1000,
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
  ...overrides,
});

let failures = 0;
const assert = (cond, label) => {
  if (cond) { record(`  ✓ ${label}`); }
  else { record(`  ✗ ${label}`); failures++; }
};

try {
  record(`# Phase 3.5 smoke (#109) — ${new Date().toISOString()}`);
  record(`socket: ${sock}`);

  // ── done ──────────────────────────────────────────────────────────────
  record("\n[1] task.done → CREW DONE");
  await sendRequest(sock, { kind: "seed", record: baseRec("done-abc12345", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "task.done", id: "done-abc12345", resultRef: "/tmp/r1" } });
  const done = captured.filter((c) => c.message.startsWith("CREW DONE"));
  assert(done.length === 1, `exactly one CREW DONE captured (got ${done.length})`);
  assert(done[0]?.project === "p", `project=p (got ${done[0]?.project})`);
  assert(/^CREW DONE \[claude\/done-abc/.test(done[0]?.message ?? ""),
    `message tag matches spec: ${done[0]?.message}`);

  // Re-apply done → state machine absorbs, no second notify.
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "task.done", id: "done-abc12345", resultRef: "/tmp/r1" } });
  assert(captured.filter((c) => c.message.startsWith("CREW DONE")).length === 1,
    "redundant task.done does NOT re-notify");

  // ── blocked ───────────────────────────────────────────────────────────
  record("\n[2] task.blocked → CREW BLOCKED");
  await sendRequest(sock, { kind: "seed", record: baseRec("blocked-1xyz", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "task.blocked", id: "blocked-1xyz", reason: "need-input",
      question: "which database backend should I target?" } });
  const blk = captured.filter((c) => c.message.startsWith("CREW BLOCKED"));
  assert(blk.length === 1, `exactly one CREW BLOCKED captured (got ${blk.length})`);
  assert((blk[0]?.message ?? "").includes("which database backend"),
    `question surfaced: ${blk[0]?.message}`);

  // ── failed ────────────────────────────────────────────────────────────
  record("\n[3] task.failed → CREW FAILED");
  await sendRequest(sock, { kind: "seed", record: baseRec("failed-9q", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "task.failed", id: "failed-9q", error: "child exited with code 137 (OOM)" } });
  const fld = captured.filter((c) => c.message.startsWith("CREW FAILED"));
  assert(fld.length === 1, `exactly one CREW FAILED captured (got ${fld.length})`);
  assert((fld[0]?.message ?? "").includes("OOM"), `error surfaced: ${fld[0]?.message}`);

  // ── liveness → no notify ──────────────────────────────────────────────
  record("\n[4] task.progress / heartbeat → no notify");
  await sendRequest(sock, { kind: "seed", record: baseRec("live-7t", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "task.progress", id: "live-7t" } });
  await sendRequest(sock, { kind: "event", project: "p",
    event: { type: "heartbeat", id: "live-7t" } });
  const liveCount = captured.length;
  assert(liveCount === 3, `liveness produced 0 new notifications (total still ${liveCount})`);

  // ── notifier-down resilience ──────────────────────────────────────────
  // Stop this daemon, restart with a notify that throws — daemon must
  // still apply events to the store.
  record("\n[5] notifier throwing → daemon survives, store still updated");
  handle.stop();
  const handle2 = startSquadrantd({
    stateRoot: join(dir, "state"),
    sockPath: sock,
    sweepMs: 0,
    notify: () => { throw new Error("cmux pane crashed"); },
  });
  try {
    await sendRequest(sock, { kind: "seed", record: baseRec("bang-pq", { state: "working" }) });
    const r = await sendRequest(sock, { kind: "event", project: "p",
      event: { type: "task.done", id: "bang-pq", resultRef: "/tmp/r-bang" } });
    assert(r?.state === "done", `event still applied (state=${r?.state})`);
    const after = await sendRequest(sock, { kind: "status", project: "p", id: "bang-pq" });
    assert(after?.state === "done", `store reflects new state after throwing notify`);
  } finally {
    handle2.stop();
  }

  record(`\nresult: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures})`);
} catch (err) {
  record(`\nUNCAUGHT: ${err?.stack || err}`);
  failures++;
} finally {
  try { handle.stop?.(); } catch { /* ignore */ }
  writeFileSync(evidencePath, log.join("\n") + "\n");
  record(`\nevidence written: ${evidencePath}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
