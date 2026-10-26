// Captain discussion threads (#1016). A thread is a fork of the captain's
// session scoped to one topic: the operator settles a decision there, the
// thread parks with a structured decision record, and the captain receives the
// decision (one mailbox message + one handoff line), never the discussion.
// Crew lifecycle events never route here — threads are not crews and the
// daemon only delivers to the captain.
//
// Driver-agnostic like side-session.ts: the CLI edge injects the runtime, the
// agent command builder and first-turn delivery.

import fs from "node:fs";
import path from "node:path";
import type { PaneRef, RuntimeDriver } from "@squadrant/shared";
import { shellQuote } from "./crew-protocol.js";
import { spillOversizedFirstTurn } from "./first-turn-spill.js";
import { appendCaptainMessage } from "./mailbox.js";
import { frameMessage } from "./squadrant-message.js";

export type ThreadState = "open" | "parked" | "closed";

export interface DecisionRecord {
  question: string;
  decision: string;
  reasons: string[];
  rejected: string[];
  actions: Array<{ crew: string; action: string }>;
  at: string;
}

export interface ThreadRecord {
  id: string;
  project: string;
  topic: string;
  crews: string[];
  state: ThreadState;
  agent: string;
  /** "fork": a fork of the captain session (claude). "seed": a fresh session
   *  seeded from the ledger + decision records (agents without fork). */
  mode: "fork" | "seed";
  /** The thread's own session id (claude: assigned up front via --session-id). */
  sessionId?: string;
  forkedAt: string;
  lastActiveAt: string;
  parkedAt?: string;
  /** cmux surface of the live tab while open. */
  surfaceId?: string;
  decisions: DecisionRecord[];
}

export const DEFAULT_MAX_THREADS = 3;
/** Resume the same session only while its prompt cache is still warm (Claude's
 *  1h cache TTL); later, fork fresh from the current captain instead. */
export const THREAD_RESUME_WINDOW_MS = 60 * 60 * 1000;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

// ─── registry I/O: <stateRoot>/<project>/threads/<id>.json ────────────────────

export function threadsDir(stateRoot: string, project: string): string {
  if (!project || /[/\\\0]|^\.\.?$/.test(project)) throw new Error(`invalid project: ${project}`);
  return path.join(stateRoot, project, "threads");
}

function threadFile(stateRoot: string, project: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`invalid thread id: ${id}`);
  return path.join(threadsDir(stateRoot, project), `${id}.json`);
}

export function writeThread(stateRoot: string, rec: ThreadRecord): void {
  const dest = threadFile(stateRoot, rec.project, rec.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.tmp`, JSON.stringify(rec, null, 2));
  fs.renameSync(`${dest}.tmp`, dest);
}

export function readThread(stateRoot: string, project: string, id: string): ThreadRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(threadFile(stateRoot, project, id), "utf-8")) as ThreadRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Every thread of `project`, oldest first. A corrupt file is skipped. */
export function listThreads(stateRoot: string, project: string): ThreadRecord[] {
  const dir = threadsDir(stateRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: ThreadRecord[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ThreadRecord);
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.forkedAt.localeCompare(b.forkedAt));
}

export function requireThread(stateRoot: string, project: string, id: string): ThreadRecord {
  const rec = readThread(stateRoot, project, id);
  if (!rec) throw new Error(`No thread '${id}' in ${project}. Run 'squadrant thread list ${project}'.`);
  return rec;
}

/** Topic → id slug, suffixed -2, -3… when taken. */
export function threadIdFor(topic: string, taken: Iterable<string>): string {
  const base = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "thread";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function threadTitleFor(project: string, id: string): string {
  return `💬 ${project}:${id}`;
}

// ─── state machine ────────────────────────────────────────────────────────────

const TRANSITIONS: Record<ThreadState, ThreadState[]> = {
  open: ["parked", "closed"],
  parked: ["open", "closed"],
  closed: [],
};

export function assertTransition(rec: ThreadRecord, to: ThreadState): void {
  if (!TRANSITIONS[rec.state].includes(to)) {
    throw new Error(`Thread '${rec.id}' is ${rec.state}; cannot move to ${to}.`);
  }
}

export function assertThreadCap(threads: ThreadRecord[], max: number): void {
  const open = threads.filter((t) => t.state === "open");
  if (open.length >= max) {
    throw new Error(
      `Thread cap reached: ${open.length}/${max} open (${open.map((t) => t.id).join(", ")}). ` +
        `Park or close one first (defaults.maxThreads).`,
    );
  }
}

/** Resume the same session within the window (cache warm), else fork fresh. */
export function planResume(rec: ThreadRecord, nowMs: number, windowMs = THREAD_RESUME_WINDOW_MS): "same" | "fresh" {
  const last = Date.parse(rec.lastActiveAt);
  return rec.mode === "fork" && rec.sessionId && Number.isFinite(last) && nowMs - last <= windowMs ? "same" : "fresh";
}

// ─── decision record ──────────────────────────────────────────────────────────

const strList = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`decision record: '${field}' must be a list of strings`);
  return v as string[];
};

/** Validate the JSON a thread writes when it parks. */
export function parseDecisionRecord(raw: string, at: string): DecisionRecord {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("decision record: not valid JSON");
  }
  for (const k of ["question", "decision"] as const) {
    if (typeof o?.[k] !== "string" || !(o[k] as string).trim()) throw new Error(`decision record: '${k}' is required`);
  }
  const actions = o.actions ?? [];
  if (!Array.isArray(actions) || actions.some((a) => typeof a?.crew !== "string" || typeof a?.action !== "string")) {
    throw new Error("decision record: 'actions' must be a list of {crew, action}");
  }
  return {
    question: (o.question as string).trim(),
    decision: (o.decision as string).trim(),
    reasons: strList(o.reasons, "reasons"),
    rejected: strList(o.rejected, "rejected"),
    actions: (actions as Array<{ crew: string; action: string }>).map(({ crew, action }) => ({ crew, action })),
    at,
  };
}

/** The ONE captain.message a park delivers — the short form of the record. */
export function formatDecisionMessage(rec: ThreadRecord, d: DecisionRecord): string {
  const lines = [
    `💬 Thread decision — ${rec.topic} (thread ${rec.id})`,
    `Q: ${d.question}`,
    `Decision: ${d.decision}`,
  ];
  if (d.reasons.length) lines.push(`Why: ${d.reasons.join("; ")}`);
  if (d.rejected.length) lines.push(`Rejected: ${d.rejected.join("; ")}`);
  if (d.actions.length) lines.push(`Actions: ${d.actions.map((a) => `${a.crew} → ${a.action}`).join("; ")}`);
  lines.push(`Full record: squadrant thread show ${rec.project} ${rec.id}`);
  return lines.join("\n");
}

/** One-line handoff summary, carrying the thread id. */
export function decisionHandoffLine(rec: ThreadRecord, d: DecisionRecord): string {
  const line = `[thread ${rec.id}] ${rec.topic}: ${d.decision}`.replace(/\s+/g, " ");
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/**
 * Append `line` to `<workspace>/handoff.json` `session.decisions`. The live
 * handoff is normally absent mid-session (startup archives it), so seed from the
 * newest archived one rather than writing a decisions-only file that would
 * shadow it on the next compact.
 */
export function appendHandoffDecision(workspaceDir: string, line: string, now: Date): void {
  const live = path.join(workspaceDir, "handoff.json");
  let doc: { written_at?: string; session?: Record<string, unknown> } = {};
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(live, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null) {
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error(`${live} is not valid JSON — not overwriting it; fix it and park again.`);
    }
  } else {
    const archived = newestArchived(path.join(workspaceDir, "handoffs"));
    if (archived) doc = archived;
  }
  const session = (doc.session && typeof doc.session === "object" ? doc.session : {}) as Record<string, unknown>;
  const decisions = Array.isArray(session.decisions) ? [...(session.decisions as unknown[])] : [];
  decisions.push(line);
  const out = { ...doc, written_at: now.toISOString(), session: { ...session, decisions } };
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(`${live}.tmp`, JSON.stringify(out, null, 2));
  fs.renameSync(`${live}.tmp`, live);
}

function newestArchived(dir: string): { written_at?: string; session?: Record<string, unknown> } | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const byMtime = files
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of byMtime) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch { /* corrupt — next */ }
  }
  return null;
}

// ─── first turns ──────────────────────────────────────────────────────────────

function renderDecisions(ds: Array<{ rec: ThreadRecord; d: DecisionRecord }>): string {
  return ds
    .map(({ rec, d }) => [
      `- [${d.at}] (${rec.id}) Q: ${d.question}`,
      `  Decision: ${d.decision}`,
      ...(d.reasons.length ? [`  Why: ${d.reasons.join("; ")}`] : []),
      ...(d.rejected.length ? [`  Rejected: ${d.rejected.join("; ")}`] : []),
      ...(d.actions.length ? [`  Actions: ${d.actions.map((a) => `${a.crew} → ${a.action}`).join("; ")}`] : []),
    ].join("\n"))
    .join("\n");
}

/** The thread prompt. Sent as the FIRST TURN, never as a system prompt: a fork
 *  keeps the captain's prompt-cache prefix only while the system prompt, tools
 *  and model match the captain's byte for byte. */
export function buildThreadPrompt(rec: ThreadRecord, opts: { seeded: boolean }): string {
  const origin = opts.seeded
    ? "You are a fresh session seeded from the captain's written state (this agent cannot fork the captain), so you know only what is written below."
    : "You were forked from the captain: everything above is the captain's history up to now.";
  return [
    `You are a discussion thread for: ${rec.topic}`,
    `(thread ${rec.id}, project ${rec.project}${rec.crews.length ? `, related crews: ${rec.crews.join(", ")}` : ""})`,
    origin,
    "",
    "Rules for this thread:",
    "- Settle this one decision with the operator. Stay on the topic.",
    "- Do not spawn crews, dispatch work, message crews, or merge. The captain coordinates; crew events keep going to the captain, not here.",
    "- When the decision is settled, write the decision record and park. This sends ONE decision message to the captain, adds a line to the handoff, and closes this tab:",
    "",
    `  squadrant thread park ${rec.project} ${rec.id} --decision-file - <<'EOF'`,
    `  {"question": "...", "decision": "...", "reasons": ["..."], "rejected": ["option — why not"], "actions": [{"crew": "<name>", "action": "..."}]}`,
    "  EOF",
    "",
    "Keep the record short (about 1–2k tokens at most). Start by restating the question in one line and asking the operator what they need.",
  ].join("\n");
}

export function buildThreadFirstTurn(
  rec: ThreadRecord,
  opts: { kind: "fork" | "seed" | "resume"; ledger: string; decisions: Array<{ rec: ThreadRecord; d: DecisionRecord }> },
): string {
  const parts: string[] = [];
  if (opts.kind === "resume") {
    parts.push(`Thread ${rec.id} resumed (${rec.topic}). Here is what changed since you parked; then continue with the operator.`);
  } else {
    parts.push(buildThreadPrompt(rec, { seeded: opts.kind === "seed" }));
  }
  if (opts.ledger.trim()) parts.push(`Crew state now:\n${opts.ledger.trim()}`);
  if (opts.decisions.length) {
    parts.push(`${opts.kind === "resume" ? "Decisions made since you parked" : "Earlier decisions on this topic"}:\n${renderDecisions(opts.decisions)}`);
  } else if (opts.kind === "resume") {
    parts.push("No new decisions since you parked.");
  }
  return parts.join("\n\n");
}

// ─── orchestration ────────────────────────────────────────────────────────────

export type ThreadLaunch =
  | { kind: "fork"; fromSessionId: string; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "seed" };

export interface ThreadDeps {
  stateRoot: string;
  runtime: RuntimeDriver;
  /** The captain's cmux workspace — thread tabs live next to the captain. */
  workspaceId: string;
  /** Captain cwd: claude resolves `--resume` against the cwd's transcript dir. */
  cwd: string;
  /** The thread's agent (the captain's agent). */
  agent: string;
  /** Current captain claude session id, or null when unknown / not claude. */
  captainSessionId: string | null;
  maxThreads: number;
  /** Agent launch command for this thread (no env prefix, no cd). */
  agentCommand: (launch: ThreadLaunch, threadId: string) => string;
  sendFirstTurn: (pane: PaneRef, text: string, preLaunchScreen: string) => Promise<{ delivered: boolean }>;
  /** Live crew ledger text ("" when none). */
  ledger: () => Promise<string>;
  newSessionId: () => string;
  now: () => Date;
}

export interface ThreadOutcome {
  thread: ThreadRecord;
  /** Human note, e.g. the non-fork fallback or the resume path taken. */
  note?: string;
}

function canFork(deps: ThreadDeps): boolean {
  return deps.agent === "claude" && !!deps.captainSessionId;
}

function seedNote(deps: ThreadDeps): string {
  return deps.agent === "claude"
    ? "No captain claude session found to fork — seeded a fresh session from the crew ledger and this topic's decision records."
    : `Agent '${deps.agent}' cannot fork a session — seeded a fresh session from the crew ledger and this topic's decision records.`;
}

async function spawnThreadTab(rec: ThreadRecord, launch: ThreadLaunch, firstTurn: string, deps: ThreadDeps): Promise<PaneRef> {
  const pane = await deps.runtime.newPane({
    workspaceId: deps.workspaceId,
    direction: "tab",
    title: threadTitleFor(rec.project, rec.id),
  });
  const preLaunchScreen = await deps.runtime.readPaneScreen(pane).catch(() => "");
  const env = `SQUADRANT_ROLE=thread SQUADRANT_THREAD_ID=${rec.id}`;
  await deps.runtime.sendToPane(pane, `cd ${shellQuote(deps.cwd)} && ${env} ${deps.agentCommand(launch, rec.id)}`);
  await deps.sendFirstTurn(pane, spillOversizedFirstTurn(firstTurn, `thread-${rec.id}`), preLaunchScreen);
  return pane;
}

function topicDecisions(rec: ThreadRecord): Array<{ rec: ThreadRecord; d: DecisionRecord }> {
  return rec.decisions.map((d) => ({ rec, d }));
}

export async function openThread(
  input: { project: string; topic: string; crews: string[] },
  deps: ThreadDeps,
): Promise<ThreadOutcome> {
  const all = listThreads(deps.stateRoot, input.project);
  assertThreadCap(all, deps.maxThreads);
  const now = deps.now().toISOString();
  const fork = canFork(deps);
  const rec: ThreadRecord = {
    id: threadIdFor(input.topic, all.map((t) => t.id)),
    project: input.project,
    topic: input.topic,
    crews: input.crews,
    state: "open",
    agent: deps.agent,
    mode: fork ? "fork" : "seed",
    forkedAt: now,
    lastActiveAt: now,
    decisions: [],
  };
  const launch: ThreadLaunch = fork
    ? { kind: "fork", fromSessionId: deps.captainSessionId!, sessionId: deps.newSessionId() }
    : { kind: "seed" };
  if (launch.kind === "fork") rec.sessionId = launch.sessionId;
  // A fork already holds the captain's view of the crews; a seed needs it written down.
  const ledger = fork ? "" : await deps.ledger();
  const pane = await spawnThreadTab(rec, launch, buildThreadFirstTurn(rec, { kind: launch.kind === "fork" ? "fork" : "seed", ledger, decisions: [] }), deps);
  rec.surfaceId = pane.surfaceId;
  writeThread(deps.stateRoot, rec);
  return { thread: rec, ...(fork ? {} : { note: seedNote(deps) }) };
}

/** Ask the open thread to write its decision record (it then runs park with --decision-file). */
export async function requestPark(project: string, id: string, deps: Pick<ThreadDeps, "stateRoot" | "runtime" | "workspaceId">): Promise<ThreadRecord> {
  const rec = requireThread(deps.stateRoot, project, id);
  assertTransition(rec, "parked");
  if (!rec.surfaceId) throw new Error(`Thread '${id}' has no live tab to ask.`);
  await deps.runtime.sendToPane(
    { workspaceId: deps.workspaceId, surfaceId: rec.surfaceId },
    frameMessage(
      { from: `captain:${project}`, project, kind: "thread.park" },
      `Park this thread now: write the decision record and run 'squadrant thread park ${project} ${id} --decision-file -' as your instructions say. If nothing is settled yet, record the open question as the decision ("not decided: …").`,
    ),
  );
  return rec;
}

/**
 * Park with a decision record: append one handoff decision line (first, so a
 * failure leaves the thread open to retry), persist the record, deliver exactly
 * ONE captain.message, then close the tab (last — the thread itself usually
 * runs this command, and closing its tab ends it). The session id is kept.
 */
export async function parkThread(
  project: string,
  id: string,
  decision: DecisionRecord,
  deps: Pick<ThreadDeps, "stateRoot" | "runtime" | "workspaceId" | "now"> & { workspaceDir: string },
): Promise<{ thread: ThreadRecord; seq: number }> {
  const rec = requireThread(deps.stateRoot, project, id);
  assertTransition(rec, "parked");
  const surfaceId = rec.surfaceId;
  const now = deps.now();
  appendHandoffDecision(deps.workspaceDir, decisionHandoffLine(rec, decision), now);
  rec.decisions.push(decision);
  rec.state = "parked";
  rec.parkedAt = rec.lastActiveAt = now.toISOString();
  delete rec.surfaceId;
  writeThread(deps.stateRoot, rec);
  const seq = await appendCaptainMessage({ stateRoot: deps.stateRoot, project, text: formatDecisionMessage(rec, decision), source: "cli", from: `thread:${rec.id}` });
  if (surfaceId) await deps.runtime.closePane({ workspaceId: deps.workspaceId, surfaceId }).catch(() => {});
  return { thread: rec, seq };
}

/**
 * Reopen a parked thread. Within the resume window: resume the same session and
 * inject the delta (crew state now + decisions from other threads since this
 * one parked). Later: fork fresh from the current captain (or seed) and inject
 * this topic's earlier decision records.
 */
export async function resumeThread(project: string, id: string, deps: ThreadDeps): Promise<ThreadOutcome> {
  const all = listThreads(deps.stateRoot, project);
  const rec = all.find((t) => t.id === id) ?? requireThread(deps.stateRoot, project, id);
  assertTransition(rec, "open");
  assertThreadCap(all, deps.maxThreads);
  const now = deps.now();
  const since = rec.parkedAt ?? rec.lastActiveAt;
  let launch: ThreadLaunch;
  let firstTurn: string;
  let note: string;

  if (planResume(rec, now.getTime()) === "same") {
    launch = { kind: "resume", sessionId: rec.sessionId! };
    const newer = all
      .filter((t) => t.id !== rec.id)
      .flatMap((t) => t.decisions.filter((d) => d.at > since).map((d) => ({ rec: t, d })))
      .sort((a, b) => a.d.at.localeCompare(b.d.at));
    firstTurn = buildThreadFirstTurn(rec, { kind: "resume", ledger: await deps.ledger(), decisions: newer });
    note = "Resumed the same session (within the resume window) with the delta since it parked.";
  } else {
    const fork = canFork(deps);
    launch = fork ? { kind: "fork", fromSessionId: deps.captainSessionId!, sessionId: deps.newSessionId() } : { kind: "seed" };
    rec.mode = fork ? "fork" : "seed";
    rec.forkedAt = now.toISOString();
    if (launch.kind === "fork") rec.sessionId = launch.sessionId;
    else delete rec.sessionId;
    firstTurn = buildThreadFirstTurn(rec, { kind: fork ? "fork" : "seed", ledger: fork ? "" : await deps.ledger(), decisions: topicDecisions(rec) });
    note = fork
      ? "Forked fresh from the current captain with this topic's earlier decisions (past the resume window)."
      : seedNote(deps);
  }

  const pane = await spawnThreadTab(rec, launch, firstTurn, deps);
  rec.state = "open";
  rec.lastActiveAt = now.toISOString();
  rec.surfaceId = pane.surfaceId;
  writeThread(deps.stateRoot, rec);
  return { thread: rec, note };
}

export async function closeThread(
  project: string,
  id: string,
  deps: Pick<ThreadDeps, "stateRoot" | "now"> & { runtime?: RuntimeDriver; workspaceId?: string },
): Promise<ThreadRecord> {
  const rec = requireThread(deps.stateRoot, project, id);
  assertTransition(rec, "closed");
  const surfaceId = rec.surfaceId;
  rec.state = "closed";
  rec.lastActiveAt = deps.now().toISOString();
  delete rec.surfaceId;
  writeThread(deps.stateRoot, rec);
  if (surfaceId && deps.runtime && deps.workspaceId) {
    await deps.runtime.closePane({ workspaceId: deps.workspaceId, surfaceId }).catch(() => {});
  }
  return rec;
}
