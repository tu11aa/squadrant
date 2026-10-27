// The crew signal path (`squadrant crew signal <state>`), shared by the CLI verb and the `squadrant mcp` tools
// so there is one implementation (#1029). Only the daemon transport (`call`) is injected.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendCaptainMessage } from "./mailbox.js";
import type { ControlEvent, TaskRecord } from "@squadrant/shared";
import { TERMINAL_STATES, stateRoot } from "@squadrant/shared";
import { scanCitations, readBranchOnlyMessages, type CiteText } from "./knowledge/cite.js";
import type { AuditSink } from "./knowledge/audit.js";

export type CrewSignalState = "done" | "blocked" | "failed" | "review";

export function buildStatusRequest(project: string, id: string) {
  return { kind: "status" as const, project, id };
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
  signal: CrewSignalState,
  o: {
    message?: string;
    question?: string;
    error?: string;
    /** Explicit override (codex); falls back to SQUADRANT_CREW_TASK_ID env. */
    taskId?: string;
    /** Explicit override (codex); falls back to SQUADRANT_CREW_PROJECT env. */
    project?: string;
    /** Injectable for tests; defaults to writing under stateRoot()/_results. */
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
export function defaultWriteResult(id: string, payload: string): string {
  const dir = join(stateRoot(), "_results");
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
/** Bound on the git read at signal time, so a slow or huge repo can never hold up a signal. */
const CITE_GIT_TIMEOUT_MS = 2000;
const citeGit = (args: string[]): string => {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: CITE_GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) throw r.error;
  return r.status === 0 ? r.stdout : "";
};

/** item.cited (#901) at `signal done|review`: rule ids named in the message or in the crew branch's own commits
 *  (deduped by sha). Lives in the CLI signal path, so it works for every agent. Never throws: a failure is one
 *  stderr note, and the signal itself has already been sent. */
export function logSignalCitations(
  state: string,
  o: { message?: string; taskId?: string; project?: string; cwd?: string; env?: NodeJS.ProcessEnv; git?: (args: string[]) => string; audit?: AuditSink },
): string[] {
  const env = o.env ?? process.env;
  const project = o.project ?? env.SQUADRANT_CREW_PROJECT;
  if ((state !== "done" && state !== "review") || !project) return [];
  const texts: CiteText[] = o.message ? [{ text: o.message, ref: `crew-${state}:${o.taskId ?? env.SQUADRANT_CREW_TASK_ID}` }] : [];
  try {
    texts.push(...readBranchOnlyMessages(o.cwd ?? process.cwd(), o.git ?? citeGit).map((c) => ({ text: c.text, ref: `git:${c.sha}`, at: c.at })));
  } catch (e) {
    process.stderr.write(`squadrant: rule citation scan of commits skipped: ${(e as Error).message}\n`);
  }
  try {
    return scanCitations(texts, { project, sink: o.audit });
  } catch (e) {
    process.stderr.write(`squadrant: rule citation scan skipped: ${(e as Error).message}\n`);
    return [];
  }
}

export async function runCrewSignal(
  signal: CrewSignalState,
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
  // Principle (#1069): state handling never blocks a message. Whatever refuses the signal, the crew's text still
  // reaches the captain (mailbox = a file write, so even a dead daemon can't drop it).
  const text = o.message ?? o.question ?? o.error;
  const forward = async (name: string | undefined, why: string) => {
    try {
      await forwardRefusedSignal(project, taskId, name, signal, text, why);
    } catch {
      /* the original refusal is the error to surface */
    }
  };
  // The record can legitimately be missing (a dropped/pruned task id, #554 —
  // terminal records are pruned past a per-project cap, or a fresh daemon
  // hasn't registered it yet). That is NOT evidence the task is terminal, so
  // it must never be treated as such — and never dereferenced blindly, or a
  // crash here drops CREW DONE exactly like #574 did, just via a new door.
  // Fall through to the normal emit, which surfaces its own clear error if the
  // id truly doesn't exist.
  let current: TaskRecord | null | undefined;
  try {
    current = (await deps.call(buildStatusRequest(project, taskId))) as TaskRecord | null | undefined;
  } catch (e) {
    await forward(undefined, `daemon unreachable: ${(e as Error).message}`);
    throw new Error(`${(e as Error).message} — your message was queued in the captain's mailbox and is delivered when the daemon is back.`);
  }
  if (current && TERMINAL_STATES.has(current.state)) {
    await forward(current.name, `task is already ${current.state} — the captain can reopen it with 'squadrant crew send'`);
    throw new Error(
      `Task ${taskId} is already terminal (state=${current.state}) — signal '${signal}' would be silently ignored by the daemon. ` +
        `Your message was forwarded to the captain, who can reopen the task with 'squadrant crew send' — its output confirms with \"↻ Task was terminal — reopened to working\" (#595). Stop here; don't signal again.`,
    );
  }
  // #1069: `done` while in review is liveness-only (#605), so it would answer success and change nothing. Only the
  // state change is refused: the crew's message still goes to the captain, and the crew is told it did.
  if (current?.state === "review" && signal === "done") {
    await forward(current.name, "task is in review — approve with 'squadrant crew approve' or send feedback");
    throw new Error(
      `Task ${taskId} is in review (held for captain approval) — done not applied. ` +
        `Your message was forwarded to the captain; wait for the captain's feedback or approval. Don't signal done again.`,
    );
  }
  if (signal === "review") rmSync(reviewNoticeMarker(taskId), { force: true });
  const req = buildSignalRequest(signal, { ...o, writeResult: o.writeResult ?? defaultWriteResult });
  // The daemon answers an event with the post-reduce record: a receipt. If it did not land in the state this
  // signal asks for (a race past the pre-check above), the caller must not see success (#1069). A repeat
  // `blocked` stays a silent no-op (#174), so only done/failed/review are checked.
  let after: TaskRecord | null | undefined;
  try {
    after = (await deps.call(req)) as TaskRecord | null | undefined;
  } catch (e) {
    const why = current ? `daemon error: ${(e as Error).message}` : `task record not found: ${(e as Error).message}`;
    await forward(current?.name, why);
    throw new Error(`${(e as Error).message} — signal not applied; your message was forwarded to the captain (mailbox).`);
  }
  const wanted = { done: "done", failed: "failed", review: "review" }[signal as string];
  if (wanted && after && typeof after.state === "string" && after.state !== wanted) {
    await forward(after.name ?? current?.name, `task is in state '${after.state}'`);
    throw new Error(`Signal '${signal}' not applied: task ${taskId} is in state '${after.state}'. Your message was forwarded to the captain; if the task needs to continue, they will 'squadrant crew send'.`);
  }
}

const reviewNoticeMarker = (taskId: string) => join(stateRoot(), "_review-done-notified", taskId);

/** Forward a refused signal's message to the captain. Only an exact repeat (same signal, same text) since the last
 *  forward is dropped: the marker holds a hash of it, and a fresh `review` signal clears it. */
async function forwardRefusedSignal(
  project: string,
  taskId: string,
  name: string | undefined,
  signal: string,
  message: string | undefined,
  why: string,
): Promise<void> {
  const marker = reviewNoticeMarker(taskId);
  const hash = createHash("sha256").update(`${signal}\0${message ?? ""}`).digest("hex");
  if (existsSync(marker) && readFileSync(marker, "utf8") === hash) return;
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, hash);
  const who = name ?? taskId.slice(0, 8);
  await appendCaptainMessage({
    stateRoot: stateRoot(),
    project,
    text: `crew ${who} → ${signal} (not applied: ${why})${message ? `: ${message}` : ""}`,
    source: "cli",
    from: `crew:${who}`,
  });
}

/** #1039: one-line success confirmation for `crew signal`, so a crew can tell the signal landed. */
export function signalConfirmation(signal: string, project: string, taskId: string): string {
  return `✔ signalled ${signal} for ${project} (task ${taskId.slice(0, 8)})`;
}

/** One full signal: emit via `runCrewSignal`, scan citations (#901), return the #1039 confirmation line. */
export async function performCrewSignal(
  signal: CrewSignalState,
  o: { message?: string; question?: string; error?: string; taskId?: string; project?: string },
  deps: { call: (req: unknown) => Promise<unknown> },
): Promise<string> {
  await runCrewSignal(signal, { ...o, writeResult: defaultWriteResult }, deps);
  logSignalCitations(signal, o);
  return signalConfirmation(signal, o.project ?? process.env.SQUADRANT_CREW_PROJECT ?? "", o.taskId ?? process.env.SQUADRANT_CREW_TASK_ID ?? "");
}
