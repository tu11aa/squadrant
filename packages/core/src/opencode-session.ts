// opencode HTTP session lookup (#786). Mirrors the route handling already proven in
// packages/agents/src/opencode/http-channel.ts (legacy /session and /api/session),
// but resolves by DIRECTORY — the one thing that channel deliberately does not do.
//
// Why directory-exact: opencode scopes GET /session by project (the repo's root commit
// hash), which every worktree shares, so "newest session" can be a crew worktree's.
// Verified live — docs/specs/2026-09-17-…-design.md §2 tests 9/10.
import { execFileSync } from "node:child_process";
import { sameDirectory, writeCaptainAddress } from "./captain-record.js";

export interface OpencodeSessionRow {
  id: string;
  directory?: string;
  time?: { created?: number; updated?: number };
}

/** GET the session list, trying the legacy route then the /api route. Never throws. */
export async function listSessions(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<OpencodeSessionRow[]> {
  for (const path of ["/session", "/api/session"]) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ac.signal });
      if (!res.ok) continue;
      const rows = (await res.json()) as unknown;
      if (Array.isArray(rows)) return rows as OpencodeSessionRow[];
    } catch {
      // transport failure or bad JSON — try the next route
    } finally {
      clearTimeout(t);
    }
  }
  return [];
}

/** One live opencode server found in the process table (#797). */
export interface LiveOpencodeServer {
  pid: number;
  port: number;
  /** `--session <id>` when the server was resumed into an existing session. */
  sessionId?: string;
}

/**
 * Parse `ps -axo pid=,command=` output into the live opencode HTTP servers it
 * describes. Pure (no I/O) so the matching rules are unit-testable without a
 * process table.
 *
 * A captain/crew boots as `opencode [--session <id>] --port <n>`; a line whose
 * executable is not `opencode`, or that has no `--port`, is ignored (the bare
 * TUI listens on an ephemeral unix socket, not TCP).
 */
export function parseLiveOpencodeServers(psOutput: string): LiveOpencodeServer[] {
  const out: LiveOpencodeServer[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2].trim();
    const exe = command.split(/\s+/)[0] ?? "";
    if (!/(^|\/)opencode$/.test(exe)) continue;
    const portRaw = command.match(/--port[= ](\d+)/)?.[1];
    if (!portRaw) continue;
    const sessionId = command.match(/--session[= ](\S+)/)?.[1];
    out.push({ pid, port: Number(portRaw), ...(sessionId ? { sessionId } : {}) });
  }
  return out;
}

function defaultPsOutput(): string {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8", timeout: 2000 });
  } catch {
    return "";
  }
}

function defaultCwdOf(pid: number): string | null {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf-8", timeout: 2000 });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * Discover the live opencode server for a captain (#797). Best-effort — null
 * when the process table is unreadable or nothing matches.
 *
 * Match order:
 *  1. a server resumed into exactly `sessionId` (the record's own session)
 *  2. a server whose process cwd is `directory`
 *
 * Unlike a self-identifying `pgrep`, this only ever looks for an address the
 * caller already knows belongs to the captain it is healing (its session id or
 * its project directory) — it never guesses a role.
 */
export function discoverLiveOpencodeServer(opts: {
  directory: string;
  sessionId?: string;
  /** Injectable process-table reader (tests). Default: `ps`. */
  psOutput?: () => string;
  /** Injectable cwd lookup (tests). Default: `lsof`. */
  cwdOf?: (pid: number) => string | null;
}): LiveOpencodeServer | null {
  const servers = parseLiveOpencodeServers((opts.psOutput ?? defaultPsOutput)());
  if (opts.sessionId) {
    const bySession = servers.find((s) => s.sessionId === opts.sessionId);
    if (bySession) return bySession;
  }
  const cwdOf = opts.cwdOf ?? defaultCwdOf;
  return servers.find((s) => sameDirectory(cwdOf(s.pid) ?? undefined, opts.directory)) ?? null;
}

/**
 * Newest session whose directory is the exact same directory. null when none.
 *
 * `createdAfterMs` (#789) restricts the result to sessions CREATED at/after a
 * timestamp — the captain's own session for a cold start. Without it, a stale
 * session the operator already had in the captain's directory (the repo root!)
 * can be "newer by updated" and get persisted as the captain's address: a silent
 * misroute. A row with no `time.created` cannot be proven fresh, so it is excluded
 * whenever the filter is active.
 */
export function newestSessionInDirectory(
  rows: OpencodeSessionRow[],
  directory: string,
  createdAfterMs?: number,
): string | null {
  const hits = rows.filter(
    (r) =>
      sameDirectory(r.directory, directory) &&
      (createdAfterMs === undefined || (r.time?.created ?? 0) >= createdAfterMs),
  );
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => ((b.time?.updated ?? 0) > (a.time?.updated ?? 0) ? b : a)).id;
}

/**
 * Poll until a session exists in `directory`. Cold starts have NO session until the
 * first turn is started (§2 test 8), so this is expected to return null for a while.
 */
export async function pollNewestSessionInDirectory(opts: {
  port: number;
  directory: string;
  createdAfterMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = newestSessionInDirectory(
      await listSessions(opts.port, opts.fetchImpl),
      opts.directory,
      opts.createdAfterMs,
    );
    if (id) return id;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * Resolve the freshly-booted captain's session id and persist the captain address.
 * Bounded: on timeout nothing is written, which reads downstream as "not deliverable"
 * — the honest outcome (§5.2).
 *
 * `launchedAt` is the moment the captain was launched (ISO). It bounds resolution to
 * sessions the captain itself created (#789) and is persisted verbatim so the record
 * reflects the launch, not the resolution.
 */
export async function resolveAndPersistOpencodeCaptain(opts: {
  stateRoot: string;
  project: string;
  port: number;
  directory: string;
  launchedAt: string;
  /**
   * #797: the session id when this launch RESUMED one (it came from the prior
   * record), so there is nothing to resolve. Persisted immediately — the #789
   * created-after gate must NOT apply to a resume, because a resumed session
   * necessarily predates `launchedAt`; gating it is why a stale port survived
   * every relaunch. Absent ⇒ a cold start, resolved by poll (with the gate).
   */
  sessionId?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (opts.sessionId) {
    writeCaptainAddress(opts.stateRoot, opts.project, {
      agent: "opencode", port: opts.port, sessionId: opts.sessionId,
      directory: opts.directory, launchedAt: opts.launchedAt,
    });
    return opts.sessionId;
  }
  const sessionId = await pollNewestSessionInDirectory({
    port: opts.port, directory: opts.directory, createdAfterMs: Date.parse(opts.launchedAt),
    timeoutMs: opts.timeoutMs, sleep: opts.sleep, fetchImpl: opts.fetchImpl,
  });
  if (!sessionId) return null;
  writeCaptainAddress(opts.stateRoot, opts.project, {
    agent: "opencode", port: opts.port, sessionId,
    directory: opts.directory, launchedAt: opts.launchedAt,
  });
  return sessionId;
}
