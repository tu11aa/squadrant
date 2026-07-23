// src/commands/crew-control.ts
import { Command } from "commander";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { sendRequest } from "@squadrant/core";
import { ensureDaemon } from "@squadrant/core";
import type { ControlEvent, Mode, Provider, TaskRecord } from "@squadrant/shared";
import { TERMINAL_STATES, loadConfig, crewBranch, resolveWorktreeBase } from "@squadrant/shared";
import { mapClaudeHookToEvent } from "@squadrant/agents";
import { filterTasks, formatCompactTasks } from "./crew-output.js";
import { crewAttachCommand } from "./crew-attach.js";
import { crewChatCommand } from "./crew-chat.js";

const SOCK = join(homedir(), ".config", "squadrant", "squadrant.sock");

// Codex thread setup is async after `dispatch` returns; let startThread finish
// before sending the first turn. Empirically codex handshake completes in well
// under a second; 1.5s is a safe margin without blocking the spawn return for
// long (this function is invoked fire-and-forget).
const CODEX_FIRST_TURN_DELAY_MS = 1500;

/**
 * Send the spawn task arg to a freshly-dispatched codex interactive task as
 * the first turn — mirrors how `squadrant crew spawn --agent claude "<task>"`
 * sends the task arg into the claude CLI's first prompt.
 *
 * Reuses the existing attach-socket `say` op (same one used by `crew send` and
 * `crew attach` follow-ups). Opens a transient socket, attaches, sends say,
 * closes. The renderer running in the captain tab attaches independently and
 * receives the streamed reply.
 */
export async function sendCodexFirstTurn(taskId: string, text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, CODEX_FIRST_TURN_DELAY_MS));
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(SOCK);
    conn.setEncoding("utf-8");
    conn.on("data", () => { /* drain attach frames; we just want to send */ });
    conn.on("error", reject);
    conn.once("connect", () => {
      try {
        conn.write(JSON.stringify({ op: "attach", taskId }) + "\n");
        conn.write(JSON.stringify({ op: "say", taskId, text }) + "\n");
      } catch (e) {
        reject(e);
        return;
      }
      // Brief flush window before close so the daemon processes both frames.
      setTimeout(() => { conn.end(); resolve(); }, 100);
    });
  });
}

export function buildDispatchRequest(o: {
  project: string; provider: Provider; mode: Mode; task: string; budgetMs?: number; cwd?: string;
  approvalPolicy?: string; roleInstructions?: string; name?: string; serverPort?: number;
}): { kind: "dispatch"; record: TaskRecord } {
  const now = Date.now();
  const attemptId = randomUUID();
  return {
    kind: "dispatch",
    record: {
      id: randomUUID(), project: o.project, provider: o.provider, mode: o.mode,
      state: "submitted", task: o.task, cwd: o.cwd, createdAt: now, lastHeartbeat: now,
      lastEvent: "dispatch", heartbeatBudgetMs: o.budgetMs ?? 300000,
      attempts: [{ attemptId, startedAt: now, lastHeartbeatAt: now }],
      ...(o.approvalPolicy ? { approvalPolicy: o.approvalPolicy } : {}),
      ...(o.roleInstructions ? { roleInstructions: o.roleInstructions } : {}),
      ...(o.name ? { name: o.name } : {}),
      ...(o.serverPort ? { serverPort: o.serverPort } : {}),
    },
  };
}

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
}

export function buildGateResolveRequest(o: { project: string; gateId: string; message: string }) {
  const lower = o.message.toLowerCase().trim();
  const decision = lower.startsWith("approve") ? "approve" : lower.startsWith("deny") ? "deny" : undefined;
  return {
    kind: "gate-resolve" as const,
    project: o.project,
    gateId: o.gateId,
    resolvedBy: "captain",
    payload: { text: o.message, ...(decision ? { decision } : {}) },
  };
}

export async function squadrantdCall(req: unknown): Promise<unknown> {
  try {
    return await sendRequest(SOCK, req);
  } catch {
    ensureDaemon(); // resolves its own entrypoint — never pass a path here
    // kickstart→socket is racy; bounded backoff. If all attempts fail,
    // throw the last error (fail loud, no scrape fallback).
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await sendRequest(SOCK, req);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }
}

/**
 * Build an explicit terminal/blocked event request from a crew's `signal`
 * verb. Defaults to reading `SQUADRANT_CREW_TASK_ID` and `SQUADRANT_CREW_PROJECT`
 * from env so the claude/opencode crew templates can run e.g.
 * `squadrant crew signal done --message "…"` without knowing their own ids.
 *
 * Explicit `taskId`/`project` (from `--task-id`/`--project` flags) take
 * precedence over env. This is the codex path: a single long-lived app-server
 * child serves all codex tasks as threads, so a process-level env var is
 * unsafe (wrong for concurrent tasks). The codex crew is told its concrete ids
 * via per-thread developerInstructions and signals with the explicit flags.
 *
 * Anti-#2576 invariant lives at the OTHER end (the hook bridge in
 * `_hook`). This builder is the *explicit* path: a crew running this verb
 * has *intentionally* declared terminal state after its own settle-check.
 */
export function buildSignalRequest(
  signal: "done" | "blocked" | "failed" | "review",
  o: {
    message?: string;
    question?: string;
    error?: string;
    /** Explicit override (codex); falls back to SQUADRANT_CREW_TASK_ID env. */
    taskId?: string;
    /** Explicit override (codex); falls back to SQUADRANT_CREW_PROJECT env. */
    project?: string;
    /** Injectable for tests; defaults to writing under ~/.config/squadrant/state/_results. */
    writeResult?: (id: string, payload: string) => string;
  },
): { kind: "event"; project: string; event: ControlEvent } {
  const taskId = o.taskId ?? process.env.SQUADRANT_CREW_TASK_ID;
  const project = o.project ?? process.env.SQUADRANT_CREW_PROJECT;
  if (!taskId)
    throw new Error("not running under a crew (SQUADRANT_CREW_TASK_ID unset)");
  if (!project)
    throw new Error("not running under a crew (SQUADRANT_CREW_PROJECT unset)");
  let event: ControlEvent;
  if (signal === "done") {
    const resultRef = o.writeResult ? o.writeResult(taskId, o.message ?? "") : "";
    event = {
      type: "task.done",
      id: taskId,
      resultRef,
      ...(o.message !== undefined ? { message: o.message } : {}),
    };
  } else if (signal === "blocked") {
    event = { type: "task.blocked", id: taskId, reason: "crew signaled blocked", question: o.question ?? "" };
  } else if (signal === "review") {
    // #599: review-gate checkpoint — crew has committed to crew/<name> and
    // wants the captain to inspect the diff before push+PR. Not terminal.
    event = { type: "task.review", id: taskId, ...(o.message !== undefined ? { message: o.message } : {}) };
  } else {
    event = { type: "task.failed", id: taskId, error: o.error ?? "crew signaled failed" };
  }
  return { kind: "event", project, event };
}

/** Default writer used by the `signal done` subcommand. Tests inject their own. */
function defaultWriteResult(id: string, payload: string): string {
  const dir = join(homedir(), ".config", "squadrant", "state", "_results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.txt`);
  writeFileSync(file, payload);
  return file;
}

/**
 * #557: `squadrant crew signal <state>` used to emit its event and exit 0
 * unconditionally — but the daemon's reduce() treats terminal states as
 * absorbing (any event on an already-terminal task record is a silent no-op,
 * see state-machine.ts). A signal that lands on a task record which is
 * already done/failed/cancelled therefore changed nothing while still
 * reporting success, exactly the class of bug #566 fixed for `crew send`:
 * a call site must confirm its effect landed or fail loudly, never
 * silent-succeed. This wraps buildSignalRequest with an upfront status check
 * so the CLI throws instead of emitting an event doomed to be ignored.
 */
export async function runCrewSignal(
  signal: "done" | "blocked" | "failed" | "review",
  o: {
    message?: string;
    question?: string;
    error?: string;
    taskId?: string;
    project?: string;
    writeResult?: (id: string, payload: string) => string;
  },
  deps: { call: (req: unknown) => Promise<unknown> },
): Promise<void> {
  const taskId = o.taskId ?? process.env.SQUADRANT_CREW_TASK_ID;
  const project = o.project ?? process.env.SQUADRANT_CREW_PROJECT;
  if (!taskId)
    throw new Error("not running under a crew (SQUADRANT_CREW_TASK_ID unset)");
  if (!project)
    throw new Error("not running under a crew (SQUADRANT_CREW_PROJECT unset)");
  // The record can legitimately be missing (a dropped/pruned task id, #554 —
  // terminal records are pruned past a per-project cap, or a fresh daemon
  // hasn't registered it yet). That is NOT evidence the task is terminal, so
  // it must never be treated as such — and never dereferenced blindly, or a
  // crash here drops CREW DONE exactly like #574 did, just via a new door.
  // Fall through to the normal emit, which surfaces its own clear error if the
  // id truly doesn't exist.
  const current = (await deps.call(buildStatusRequest(project, taskId))) as TaskRecord | null | undefined;
  if (current && TERMINAL_STATES.has(current.state)) {
    throw new Error(
      `Task ${taskId} is already terminal (state=${current.state}) — signal '${signal}' would be silently ignored by the daemon. ` +
        `Stop here: your task record was never reopened for this turn. Ask the captain to run 'squadrant crew send' to reopen it before signaling again.`,
    );
  }
  const req = buildSignalRequest(signal, { ...o, writeResult: o.writeResult ?? defaultWriteResult });
  await deps.call(req);
}

/**
 * Pure. Resolve a crew name to its most-recent task record (#574 tie-break —
 * same rule as diff.ts's resolveDiffTarget / crew-spawn.ts's pickMostRecentTask).
 * Approve needs the full record (id + state), not just the worktree cwd.
 */
export function resolveApproveTarget(tasks: TaskRecord[], crew: string): TaskRecord | null {
  const matches = tasks.filter((t) => t.name === crew);
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
}

/** Default push: `git push -u origin <branch>` from the crew's worktree. */
function defaultPushBranch(cwd: string, branch: string): void {
  execFileSync("git", ["-C", cwd, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Default PR creation via `gh pr create`; returns the created PR's URL (gh's stdout). */
function defaultCreatePr(cwd: string, o: { base: string; branch: string; title: string; body: string }): string {
  return execFileSync(
    "gh", ["pr", "create", "--base", o.base, "--head", o.branch, "--title", o.title, "--body", o.body],
    { cwd, encoding: "utf-8" },
  ).trim();
}

/**
 * `squadrant crew approve` — the accept side of the #599 review gate. Only
 * valid on a task in 'review' state (set by `squadrant crew signal review`):
 * pushes crew/<name> to origin, opens the PR via `gh pr create`, then emits
 * task.done to terminalize. The reject path is the EXISTING `crew send`
 * feedback loop — no new machinery there (runCrewSend already clears
 * 'review' back to 'working' before delivering the captain's message).
 */
export async function runCrewApprove(
  project: string,
  crew: string,
  deps: {
    call: (req: unknown) => Promise<unknown>;
    pushBranch?: (cwd: string, branch: string) => void;
    createPr?: (cwd: string, o: { base: string; branch: string; title: string; body: string }) => string;
  },
): Promise<string> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);

  const tasks = (await deps.call({ kind: "list", project })) as TaskRecord[];
  const task = resolveApproveTarget(tasks, crew);
  if (!task) throw new Error(`Crew '${crew}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  if (task.state !== "review") {
    throw new Error(
      `Crew '${crew}' is not awaiting review (state=${task.state}). Only a crew that signaled 'review' can be approved.`,
    );
  }

  const cwd = task.cwd ?? proj.path;
  const base = resolveWorktreeBase(proj.path);
  const branch = crewBranch(crew);
  const title = (task.task ?? branch).split(/\r?\n/)[0].trim().slice(0, 100);
  const body = (task.reviewNote ?? task.task ?? "").trim();

  const pushBranch = deps.pushBranch ?? defaultPushBranch;
  const createPr = deps.createPr ?? defaultCreatePr;
  pushBranch(cwd, branch);
  const prUrl = createPr(cwd, { base, branch, title, body });

  await deps.call({
    kind: "event",
    project,
    event: { type: "task.done", id: task.id, resultRef: "", message: `Approved — PR opened: ${prUrl}`, source: "approve" },
  });

  return prUrl;
}

/**
 * Attach the control-plane verbs onto an existing `squadrant crew` command so
 * they coexist with the legacy cmux-scrape verbs (spawn/send/read/close/list).
 * The control-plane task listing is `tasks` (not `list`) to avoid colliding
 * with the legacy `list` that captains' playbook still uses. This is the
 * deferred-legacy coexistence state — wired so PR #85 does not break live
 * captains. Migrating captain-ops to the control-plane verbs is the deferred
 * legacy-re-pointing spec's job.
 */
export function addControlPlaneCrewCommands(crew: Command): void {
  crew
    .command("dispatch <project> <task>")
    .description("Dispatch a crew task via the control-plane daemon")
    .requiredOption("--provider <p>", "claude|opencode|codex (gemini: experimental, headless not supported)")
    .option("--mode <m>", "headless|interactive", "interactive")
    .option("--cwd <dir>", "working dir for the crew (project/worktree); required for codex to edit code")
    .action(async (project: string, task: string, opts: { provider: Provider; mode: Mode; cwd?: string }) => {
      const req = buildDispatchRequest({ project, task, provider: opts.provider, mode: opts.mode, cwd: opts.cwd });
      const r = await squadrantdCall(req);
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  crew
    .command("status <project> <id>")
    .description("Read a control-plane task's state")
    .action(async (project: string, id: string) => {
      const r = await squadrantdCall(buildStatusRequest(project, id));
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  crew
    .command("tasks <project>")
    .description("List control-plane tasks for a project (control-plane analogue of legacy `list`), or purge a task with --purge")
    .option("--json", "Full JSON output (one or more records)")
    .option("--id <taskId>", "Show only tasks matching this id prefix")
    .option("--state <state>", "Filter by task state")
    .option("--state-only <taskId>", "Print just the state string for a single task")
    .option("--purge <taskId>", "Purge a task record from the store (default: only terminal records)")
    .option("--force", "Force-purge a non-terminal record (use with --purge)")
    .option("--all-terminal", "Purge all terminal (done/cancelled/failed) records for the project")
    .action(async (project: string, opts: { json?: boolean; id?: string; state?: string; stateOnly?: string; purge?: string; force?: boolean; allTerminal?: boolean }) => {
      if (opts.allTerminal) {
        const tasks = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
        const terminal = tasks.filter((t) => TERMINAL_STATES.has(t.state as any));
        for (const t of terminal) {
          await squadrantdCall({ kind: "purge", project, id: t.id, force: false });
        }
        console.log(`purged ${terminal.length} terminal record(s)`);
        return;
      }
      if (opts.purge) {
        const r = await squadrantdCall({ kind: "purge", project, id: opts.purge, force: opts.force ?? false }) as TaskRecord;
        console.log(`purged ${r.provider}/${r.id} (was ${r.state})`);
        return;
      }
      const raw = (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
      let records = raw;
      if (opts.stateOnly) {
        records = filterTasks(records, { id: opts.stateOnly, stateOnly: true });
        process.stdout.write(formatCompactTasks(records, { stateOnly: true }) + "\n");
        return;
      }
      records = filterTasks(records, { id: opts.id, state: opts.state });
      const compact = opts.json !== true;
      process.stdout.write(formatCompactTasks(records, { compact }) + "\n");
    });

  // TODO(downstream interactive-wiring spec): deliverReply is not yet wired in
  // squadrantd, so this transitions task state but never reaches the agent. Deferred.
  // --gate <gateId> routes through the gate-resolve verb instead (spec §4.9).
  crew
    .command("reply <project> <id> <message>")
    .description("Reply to a blocked control-plane task (delivery deferred), or resolve a gate via --gate")
    .option("--gate <gateId>", "resolve a pending gate by id (codex interactive, spec §4.9)")
    .action(async (project: string, id: string, message: string, opts: { gate?: string }) => {
      if (opts.gate) {
        const r = await squadrantdCall(buildGateResolveRequest({ project, gateId: opts.gate, message }));
        process.stdout.write(JSON.stringify(r) + "\n");
        return;
      }
      process.stderr.write("reply delivery is not yet wired (deferred); state transitioned only\n");
      const r = await squadrantdCall({ kind: "reply", project, id, message });
      process.stdout.write(JSON.stringify(r) + "\n");
    });

  // Bridge from Claude's native Stop/SubagentStop/SessionEnd hooks to the
  // squadrant control plane. Reads hook payload JSON on stdin (Claude hook
  // contract); env-gated on SQUADRANT_CREW_TASK_ID/SQUADRANT_CREW_PROJECT so the
  // hook is a no-op outside spawned crews. Anti-#2576: maps only to
  // task.progress (liveness), never task.done — terminal state comes from
  // `squadrant crew signal` (explicit, post-settle-check).
  crew
    .command("_hook <event>", { hidden: true })
    .description("internal: bridge from claude Stop/SubagentStop/SessionEnd hooks to squadrantd")
    .action(async (event: string) => {
      const taskId = process.env.SQUADRANT_CREW_TASK_ID;
      const project = process.env.SQUADRANT_CREW_PROJECT;
      if (!taskId || !project) { process.exit(0); }
      // Drain stdin (Claude posts hook JSON there). Tolerate missing/malformed.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk;
      } catch { /* ignore */ }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try { payload = JSON.parse(stdin); } catch { /* ignore malformed */ }
      }
      const ev = mapClaudeHookToEvent(event, payload, taskId);
      if (!ev) { process.exit(0); }
      try {
        await squadrantdCall({ kind: "event", project, event: ev });
      } catch {
        // Daemon down: do NOT block Claude. Hook contract requires exit 0;
        // a non-zero exit would block the conversation.
      }
      process.exit(0);
    });

  // The explicit done/blocked/failed signal — the anti-#2576 escape from
  // liveness-only Stop hooks. The crew runs this AFTER its own settle-check
  // (git status clean, etc.) to declare terminal state to the captain.
  crew
    .command("signal <state>")
    .description("Emit explicit terminal/review signal from a crew session: done|blocked|failed|review (reads SQUADRANT_CREW_* env, or --task-id/--project for codex)")
    .option("--message <m>", "Summary written to resultRef (done), or review summary (review)")
    .option("--question <q>", "Question to surface to captain (blocked)")
    .option("--error <e>", "Error message (failed)")
    .option("--task-id <id>", "Explicit task id (codex; overrides SQUADRANT_CREW_TASK_ID env)")
    .option("--project <p>", "Explicit project (codex; overrides SQUADRANT_CREW_PROJECT env)")
    .action(async (state: string, opts: { message?: string; question?: string; error?: string; taskId?: string; project?: string }) => {
      if (state !== "done" && state !== "blocked" && state !== "failed" && state !== "review") {
        process.stderr.write(`unknown signal '${state}' (expected: done|blocked|failed|review)\n`);
        process.exit(2);
      }
      try {
        await runCrewSignal(state as "done" | "blocked" | "failed" | "review", {
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          ...(opts.question !== undefined ? { question: opts.question } : {}),
          ...(opts.error !== undefined ? { error: opts.error } : {}),
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
          ...(opts.project !== undefined ? { project: opts.project } : {}),
          writeResult: defaultWriteResult,
        }, { call: squadrantdCall });
        process.exit(0);
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        process.exit(1);
      }
    });

  // #599: accept side of the review gate. `squadrant crew signal review` puts
  // the task in 'review'; this command is the only path out besides `crew send`
  // (reject/feedback) — push + open the PR, then terminalize DONE.
  crew
    .command("approve <project> <crew>")
    .description("Approve a crew's reviewed work: push crew/<name> + open a PR, then terminalize DONE (#599)")
    .action(async (project: string, crewName: string) => {
      try {
        const prUrl = await runCrewApprove(project, crewName, { call: squadrantdCall });
        process.stdout.write(`✔ Approved ${crewBranch(crewName)} — pushed + PR opened: ${prUrl}\n`);
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        process.exit(1);
      }
    });

  crew.addCommand(crewAttachCommand);
  crew.addCommand(crewChatCommand);
}

// Standalone control-plane-only command (kept for back-compat / direct use;
// the CLI composes these onto the legacy `crew` command via the function above).
export const crewControlCommand = new Command("crew")
  .description("Dispatch and track crew via the squadrant control plane");
addControlPlaneCrewCommands(crewControlCommand);
