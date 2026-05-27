#!/usr/bin/env node
// scripts/mailbox-injector-smoke.mjs
//
// E2E smoke for mailbox-injector refactor (replaces #109/#111 socket push).
// Spins up a real cockpitd on a temp socket + stateRoot, drives a few
// task.done events through the daemon, then verifies:
//   1. defaultNotify writes structured entries to <stateRoot>/inbox/<project>.log
//   2. readFromCursor yields each entry exactly once, in order
//   3. writeCursor persists, readCursor returns the saved seq
//   4. After a simulated "injector offline" window, resuming from the cursor
//      reads only the entries added during the outage (no duplicates, no gaps)
//
// Uses startCockpitd + sendRequest directly (same pattern as
// scripts/smoke-push-notify.mjs) rather than env vars — the daemon's CLI
// surface takes stateRoot/sockPath as arguments, not env vars.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const distEntry = pathToFileURL(join(__dirname, "..", "dist", "control", "cockpitd.js")).href;
const distProto = pathToFileURL(join(__dirname, "..", "dist", "control", "protocol.js")).href;
const distMailbox = pathToFileURL(join(__dirname, "..", "dist", "control", "mailbox.js")).href;

const { startCockpitd } = await import(distEntry);
const { sendRequest } = await import(distProto);
const mailbox = await import(distMailbox);

const evidencePath = join(__dirname, "..", ".mailbox-injector-smoke.local");
const evidence = [];
const record = (m) => { evidence.push(m); process.stdout.write(m + "\n"); };

const dir = mkdtempSync(join(tmpdir(), "mailbox-smoke-"));
const stateRoot = join(dir, "state");
const sock = join(dir, "c.sock");

const handle = startCockpitd({ stateRoot, sockPath: sock, sweepMs: 0 });

const baseRec = (id, overrides = {}) => ({
  id, project: "demo", provider: "claude", mode: "headless",
  state: "submitted", task: "mailbox smoke", cwd: "/",
  createdAt: 1, lastHeartbeat: 1, lastEvent: "",
  heartbeatBudgetMs: 60000,
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
  ...overrides,
});

let failures = 0;
const assert = (cond, label) => {
  if (cond) { record(`  ✓ ${label}`); }
  else { record(`  ✗ ${label}`); failures++; }
};

try {
  record(`# Mailbox + injector smoke — ${new Date().toISOString()}`);
  record(`state: ${stateRoot}`);
  record(`socket: ${sock}`);

  record("\n[1] dispatch + task.done → mailbox file gets one entry");
  await sendRequest(sock, { kind: "seed", record: baseRec("smoke-1abcdef0", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.done", id: "smoke-1abcdef0", resultRef: "/r1" } });
  await new Promise((r) => setTimeout(r, 150));

  const logPath = join(stateRoot, "inbox", "demo.log");
  assert(existsSync(logPath), `mailbox file created at ${logPath}`);
  const lines1 = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  assert(lines1.length === 1, `exactly one entry (got ${lines1.length})`);
  const entry1 = JSON.parse(lines1[0]);
  assert(entry1.seq === 1, `seq=1 (got ${entry1.seq})`);
  assert(entry1.kind === "task.done", `kind=task.done (got ${entry1.kind})`);
  assert(entry1.taskId === "smoke-1abcdef0", `taskId matches`);

  record("\n[2] simulate injector reading from cursor");
  const items = [];
  for await (const it of mailbox.readFromCursor({ stateRoot, project: "demo", fromSeq: 1 })) items.push(it);
  assert(items.length === 1, `injector reads 1 entry from cursor (got ${items.length})`);
  await mailbox.writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
  const cursor = await mailbox.readCursor({ stateRoot, project: "demo", subscriber: "captain" });
  assert(cursor?.lastAckedSeq === 1, `cursor advanced to 1 (got ${cursor?.lastAckedSeq})`);

  record("\n[3] simulate injector 'offline' — dispatch more events");
  await sendRequest(sock, { kind: "seed", record: baseRec("smoke-2feedface", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.done", id: "smoke-2feedface", resultRef: "/r2" } });
  await sendRequest(sock, { kind: "seed", record: baseRec("smoke-3deadbeef", { state: "working" }) });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.blocked", id: "smoke-3deadbeef", question: "what now?" } });
  await new Promise((r) => setTimeout(r, 200));

  record("\n[4] injector resumes — reads only new events, in order, no duplicates");
  const items2 = [];
  for await (const it of mailbox.readFromCursor({ stateRoot, project: "demo", fromSeq: 2 })) items2.push(it);
  assert(items2.length === 2, `replay yields exactly 2 new entries (got ${items2.length})`);
  assert(items2[0]?.seq === 2 && items2[1]?.seq === 3,
    `seqs are 2,3 (got ${items2.map((x) => x.seq).join(",")})`);
  assert(items2[0]?.kind === "task.done", `seq=2 is task.done`);
  assert(items2[1]?.kind === "task.blocked", `seq=3 is task.blocked`);

  record("\n[5] liveness events (task.started, task.progress) do NOT write to mailbox");
  // firePush gates on ATTENTION_STATES = {done, blocked, failed, stalled}.
  // task.started / task.progress drive working state → must be suppressed.
  await sendRequest(sock, { kind: "seed", record: baseRec("smoke-4cafebabe", { state: "submitted" }) });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.started", id: "smoke-4cafebabe" } });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.progress", id: "smoke-4cafebabe" } });
  await sendRequest(sock, { kind: "event", project: "demo",
    event: { type: "task.progress", id: "smoke-4cafebabe" } });
  await new Promise((r) => setTimeout(r, 200));

  const linesAfter = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  assert(linesAfter.length === 3,
    `mailbox still has 3 entries after liveness traffic (got ${linesAfter.length}) — liveness suppressed`);

  record(`\n${failures === 0 ? "✔ ALL SMOKE ASSERTIONS PASSED" : `✗ ${failures} FAILURES`}`);
} finally {
  handle.stop();
  writeFileSync(evidencePath, evidence.join("\n") + "\n");
  record(`evidence: ${evidencePath}`);
  process.exit(failures > 0 ? 1 : 0);
}
