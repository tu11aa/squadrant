// opencode HTTP session lookup (#786). Mirrors the route handling already proven in
// packages/agents/src/opencode/http-channel.ts (legacy /session and /api/session),
// but resolves by DIRECTORY — the one thing that channel deliberately does not do.
//
// Why directory-exact: opencode scopes GET /session by project (the repo's root commit
// hash), which every worktree shares, so "newest session" can be a crew worktree's.
// Verified live — docs/specs/2026-09-17-…-design.md §2 tests 9/10.
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
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
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
