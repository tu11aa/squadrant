// handoff.ts — `squadrant handoff facts <project>` (#650/#651).
//
// Gathers verified FACTS from trust-ordered/ground-truth sources — gh API
// (always fresh) > local git (marked with fetch age) > claude-mem
// (distilled, can be stale) — plus a CHECKPOINT (the newest archived
// handoff, read in full — it already covers history up to the moment it
// was written) and the GAP (captain sessions that started after it,
// attributed via the registry rather than guessed from file mtimes or
// content-sniffed for role — that's the work no handoff covers, and the
// only transcripts actually read). Also verifies liveRepo.branchState as
// explicit enum flags (upstream ahead/behind/diverged/gone/no-upstream,
// merged-into-base, dirty working tree, sitting on an unexpected branch) —
// a cheap model can act on these without interpreting prose. Emits
// everything grouped by source with provenance. Does NOT author a handoff:
// no currentState/nextSteps/decisions synthesis. Composing the actual
// handoff from these facts is judgment and belongs to whoever reads them
// (the captain). Read-only and side-effect-free by default — safe for
// #641's `squadrant brief` to call as one source among several, and safe
// to call repeatedly. The one opt-in exception is `--fetch`, which runs a
// single `git fetch origin` before computing branchState; without it,
// branchState is only ever as fresh as the last fetch (see fetchAgeMs).
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import { loadConfig, resolveWorktreeBase, workspacePath } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { squadrantdCall } from "./crew-control.js";
import { gatherLiveRepoState, defaultCommandRunner } from "../lib/handoff-live-repo.js";
import type { CommandRunner } from "../lib/handoff-live-repo.js";
import { queryClaudeMem } from "../lib/handoff-claude-mem.js";
import { extractTranscriptTail } from "../lib/handoff-transcript.js";
import { readNewestArchivedHandoff } from "../lib/handoff-archive.js";
import { readCaptainSessionRegistry, selectGapSessions } from "../lib/captain-session-registry.js";
import { captainContext } from "../lib/captain-context.js";
import { findHandoff, computeFreshness, describeSession, archiveLiveHandoff, toSessionToRead } from "../lib/handoff-read.js";
import type { FoundHandoff, SessionToRead } from "../lib/handoff-read.js";
import { assembleHandoffFacts, SESSION_WINDOW_MS } from "../lib/handoff-facts.js";
import type { HandoffFacts, SessionWithTranscript } from "../lib/handoff-facts.js";

const CLAUDE_MEM_DB_PATH = path.join(os.homedir(), ".claude-mem", "claude-mem.db");

async function defaultFetchTasks(project: string): Promise<TaskRecord[]> {
  return (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
}

async function defaultFetchOpenTabs(project: string): Promise<string[]> {
  const { runCrewList } = await import("./crew.js");
  return (await runCrewList(project)).map((c) => c.name);
}

export interface HandoffFactsDeps {
  claudeMemDbPath?: string;
  now?: string;
  windowMs?: number;
  /** The running session's own id (CLAUDE_CODE_SESSION_ID) — excludes it from the window by identity, never by mtime. `undefined` reads the real env var; pass `null` explicitly to simulate "unknown". */
  currentSessionId?: string | null;
  fetchTasks?: (project: string) => Promise<TaskRecord[]>;
  runner?: CommandRunner;
  /** Names of crews whose tab is still open. Default: `crew list` (cmux); a failure means none known. */
  fetchOpenTabs?: (project: string) => Promise<string[]>;
  /** Opt-in: runs `git fetch origin` before computing branchState. Default false — this command stays read-only/side-effect-free unless the caller explicitly asks. */
  fetch?: boolean;
}

export async function runHandoffFacts(project: string, deps: HandoffFactsDeps = {}): Promise<HandoffFacts> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }

  // Only used when gh is entirely unavailable — gatherLiveRepoState prefers
  // the gh API's default-branch answer (always fresh, no fetch needed).
  const fallbackBaseBranch = resolveWorktreeBase(proj.path);

  let tasks: TaskRecord[];
  try {
    tasks = await (deps.fetchTasks ?? defaultFetchTasks)(project);
  } catch {
    // Daemon unreachable or an injected source failed — degrade to no
    // live-crew data rather than fail the whole gather.
    tasks = [];
  }

  const nowIso = deps.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const fallbackWindowMs = deps.windowMs ?? SESSION_WINDOW_MS;

  let openTabs: string[] = [];
  try {
    openTabs = await (deps.fetchOpenTabs ?? defaultFetchOpenTabs)(project);
  } catch { /* no cmux / not launched — fall back to task state alone */ }

  const live = gatherLiveRepoState(proj.path, fallbackBaseBranch, tasks, deps.runner ?? defaultCommandRunner, nowMs, deps.fetch ?? false, new Set(openTabs));
  const claudeMem = queryClaudeMem(deps.claudeMemDbPath ?? CLAUDE_MEM_DB_PATH, project);

  // #983: exchange lives in workspace/<p>/; the old spoke vault is still read for one version.
  const vaults = [workspacePath(project), ...(proj.spokeVault ? [proj.spokeVault] : [])];
  const checkpoint = vaults
    .map((v) => readNewestArchivedHandoff(v, nowMs))
    .reduce((a, b) => (!a || (b && b.ageMs < a.ageMs) ? b : a), null);

  const currentSessionId = deps.currentSessionId !== undefined ? deps.currentSessionId : (process.env.CLAUDE_CODE_SESSION_ID ?? null);

  let registryNote: string | null = null;
  let gapSessions: SessionWithTranscript[] = [];
  let usedFallbackWindow = false;
  if (currentSessionId === null) {
    // Can't safely tell which registered session (if any) is "self" — the
    // exact self-read #650 originally hit. Skip the gap rather than risk it.
    registryNote = "current session id unknown (CLAUDE_CODE_SESSION_ID unset) — cannot safely exclude the running session, so the gap was skipped";
  } else {
    const allRecords = vaults.flatMap((v) => readCaptainSessionRegistry(v));
    if (allRecords.length === 0) {
      registryNote = "no session registry found yet for this project (#651's SessionStart hook may not have fired before now)";
    }
    const selection = selectGapSessions(allRecords, currentSessionId, checkpoint, nowMs, fallbackWindowMs);
    usedFallbackWindow = selection.usedFallbackWindow;
    // Only the gap's transcripts are ever read — sessions before the
    // checkpoint are already covered by it, so re-reading them is exactly
    // the wasted work #651's correction exists to avoid.
    gapSessions = selection.gapSessions.map((session) => ({ session, transcript: extractTranscriptTail(session.transcriptPath) }));
  }

  return assembleHandoffFacts(live, claudeMem, gapSessions, checkpoint, nowIso, {
    registryNote,
    usedFallbackWindow,
    fallbackWindowMs,
    captainContext: captainContext(project),
  });
}

export interface HandoffReadResult {
  exists: boolean;
  handoff: unknown;
  fresh: boolean;
  ageDays: number | null;
  source: FoundHandoff["source"] | null;
  path: string | null;
  archivedTo: string | null;
  warning: string | null;
  /** Present only when stale: read these transcripts (newest first) before reporting ready. */
  instruction: string | null;
  sessionsToRead: SessionToRead[];
}

export interface HandoffReadDeps {
  now?: string;
  currentSessionId?: string | null;
  /** Skip archiving the live file. */
  keep?: boolean;
  windowMs?: number;
}

/** #1155: the one handoff reader. Live → newest archive (workspace + legacy spoke, #983), archives the live file once read, and returns a freshness verdict. */
export function runHandoffRead(project: string, deps: HandoffReadDeps = {}): HandoffReadResult {
  const proj = loadConfig().projects[project];
  if (!proj) throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);

  const nowIso = deps.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const vault = workspacePath(project);
  const vaults = [vault, ...(proj.spokeVault ? [proj.spokeVault] : []), path.join(os.homedir(), "squadrant-hub", "spokes", project)];

  const found = findHandoff([...new Set(vaults)]);
  const currentSessionId = deps.currentSessionId !== undefined ? deps.currentSessionId : (process.env.CLAUDE_CODE_SESSION_ID ?? null);

  let sessions: ReturnType<typeof describeSession>[] = [];
  let unknownSelf = false;
  if (currentSessionId === null) {
    unknownSelf = true; // can't tell which registered session is us — listing it would make the captain read itself
  } else {
    const seen = new Set<string>();
    sessions = vaults
      .flatMap((v) => readCaptainSessionRegistry(v))
      .filter((r) => r.sessionId !== currentSessionId && !seen.has(r.sessionId) && seen.add(r.sessionId))
      .map(describeSession);
  }

  const verdict = computeFreshness(found, sessions, nowMs, deps.windowMs ?? SESSION_WINDOW_MS);
  const warnings = [verdict.warning, unknownSelf ? "current session id unknown (CLAUDE_CODE_SESSION_ID unset): previous sessions could not be listed safely" : null].filter(Boolean);
  const fresh = verdict.fresh && !unknownSelf;

  let archivedTo: string | null = null;
  if (found?.source === "live" && !deps.keep) archivedTo = archiveLiveHandoff(vault, found.path, new Date(nowMs));

  return {
    exists: found !== null,
    handoff: found?.content ?? null,
    fresh,
    ageDays: verdict.ageDays,
    source: found?.source ?? null,
    path: found?.path ?? null,
    archivedTo,
    warning: warnings.length ? warnings.join("; ") : null,
    instruction: fresh
      ? null
      : "STALE: read the previous captain transcripts in sessionsToRead (at least the newest, in full) before reporting ready, and name the sessions you read in the ready report.",
    sessionsToRead: verdict.sessionsToRead.map(toSessionToRead),
  };
}

export const handoffCommand = new Command("handoff").description(
  "Handoff continuity — gather verified facts for the captain to synthesize a handoff from (#650/#651)",
);

handoffCommand
  .command("facts <project>")
  .description(
    "Gather structured facts (gh API > local git > claude-mem > registry-attributed session window) — NOT a handoff. Read-only, pre-rendered JSON on stdout; the caller synthesizes.",
  )
  .option("--fetch", "update remote-tracking refs (git fetch origin) before computing branch state — the only opt-in exception to this command's read-only contract", false)
  .action(async (project: string, opts: { fetch: boolean }) => {
    const out = await runHandoffFacts(project, { fetch: opts.fetch });
    console.log(JSON.stringify(out, null, 2));
  });

handoffCommand
  .command("read <project>")
  .description(
    "The one handoff reader (#1155): live handoff.json, else the newest archive; archives the live file once read; returns { fresh, ageDays, source, path, warning, sessionsToRead[] }. A stale verdict means read the listed captain transcripts before reporting ready.",
  )
  .option("--keep", "do not archive the live handoff.json after reading", false)
  .action((project: string, opts: { keep: boolean }) => {
    console.log(JSON.stringify(runHandoffRead(project, { keep: opts.keep }), null, 2));
  });
