// handoff-read.ts — #1155: the single handoff reader with a freshness verdict.
// Replaces the split between read-handoff.sh (live file only, archives it) and
// `handoff facts` (checkpoint + sessions started after it). The pure verdict
// (`computeFreshness`) takes a clock and plain records so it is unit-testable;
// the I/O (`findHandoff`, `describeSession`, `archiveLiveHandoff`) stays thin.
import fs from "node:fs";
import path from "node:path";
import type { CaptainSessionRecord } from "./handoff-facts.js";

export interface FoundHandoff {
  source: "live" | "archive";
  path: string;
  content: unknown;
  /** When the handoff was written: `written_at` if present, else file mtime. */
  writtenAtMs: number;
}

export interface SessionActivity {
  record: CaptainSessionRecord & { endedAt?: string };
  lastActivityMs: number;
  /** Local calendar days (YYYY-MM-DD) with transcript entries. */
  activeDays: string[];
  wroteHandoff: boolean;
  /** The transcript's `customTitle` (e.g. `squadrant-captain-<p>`), when it has one. */
  title?: string;
  /** No transcript file on disk: lastActivityMs is just startedAt and there is nothing to read. */
  transcriptMissing?: boolean;
}

export interface SessionToRead {
  name: string;
  sessionId: string;
  startedAt: string;
  lastActivity: string;
  endedAt: string;
  activeDays: string[];
  wroteHandoff: boolean;
  transcriptPath: string;
  /** True when the transcript file is gone — do not try to read it. */
  transcriptMissing: boolean;
}

export interface Freshness {
  fresh: boolean;
  ageDays: number | null;
  warning: string | null;
  /** Sessions with activity after the handoff (or, with no handoff, recent ones), newest activity first. */
  sessionsToRead: SessionActivity[];
}

/** A session writes its handoff as its last act; its closing turn lands seconds after `written_at`. Activity within this grace is not "later work". */
export const HANDOFF_GRACE_MS = 10 * 60_000;

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dayNumber = (ms: number): number => {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
};

/**
 * Pure verdict. Fresh iff the handoff was written today or yesterday (local
 * days) AND no session other than the current one had activity after it.
 * Activity, not `startedAt`: a long-lived session that wrote the handoff and
 * kept working must still count. `sessions` must already exclude the current one.
 */
export function computeFreshness(
  handoff: Pick<FoundHandoff, "source" | "writtenAtMs"> | null,
  sessions: SessionActivity[],
  nowMs: number,
  noHandoffWindowMs: number,
): Freshness {
  const byActivity = (a: SessionActivity, b: SessionActivity) => b.lastActivityMs - a.lastActivityMs;
  if (!handoff) {
    const recent = sessions.filter((s) => nowMs - s.lastActivityMs <= noHandoffWindowMs).sort(byActivity);
    const gone = recent.filter((s) => s.transcriptMissing).length;
    const note = gone > 0 ? `; ${gone} listed session(s) have no transcript file (transcriptMissing: true) and cannot be read` : "";
    return { fresh: false, ageDays: null, warning: `no handoff found (live or archived), rebuild state from the readable sessions${note}`, sessionsToRead: recent };
  }
  const ageDays = dayNumber(nowMs) - dayNumber(handoff.writtenAtMs);
  const later = sessions.filter((s) => s.lastActivityMs > handoff.writtenAtMs + HANDOFF_GRACE_MS).sort(byActivity);
  const reasons: string[] = [];
  if (ageDays > 1) reasons.push(`old handoff from ${localDay(handoff.writtenAtMs)} (${ageDays} days ago)`);
  if (later.length > 0) reasons.push(`${later.length} other captain session(s) active after it was written`);
  if (reasons.length > 0 && handoff.source === "archive") reasons.unshift("no live handoff.json; using the newest archived (already-read) one");
  const missing = later.filter((s) => s.transcriptMissing).length;
  if (missing > 0) reasons.push(`${missing} of them have no transcript file on disk (transcriptMissing: true), so they cannot be read`);
  const fresh = ageDays <= 1 && later.length === 0;
  return { fresh, ageDays, warning: reasons.length ? reasons.join("; ") : null, sessionsToRead: later };
}

export function toSessionToRead(s: SessionActivity): SessionToRead {
  const last = new Date(s.lastActivityMs).toISOString();
  const endedMs = s.record.endedAt ? Date.parse(s.record.endedAt) : NaN;
  // An end earlier than later activity belongs to a session that was resumed: not its real end.
  const ended = !Number.isNaN(endedMs) && endedMs >= s.lastActivityMs - 60_000 ? s.record.endedAt : undefined;
  return {
    name: s.title ?? `${s.record.agent}-captain-${s.record.project}`,
    sessionId: s.record.sessionId,
    startedAt: s.record.startedAt,
    lastActivity: last,
    endedAt: ended ?? `no end recorded (last activity ${last})`,
    activeDays: s.activeDays,
    wroteHandoff: s.wroteHandoff,
    transcriptPath: s.record.transcriptPath,
    transcriptMissing: s.transcriptMissing === true,
  };
}

function writtenAt(content: unknown, mtimeMs: number): number {
  const w = (content as { written_at?: unknown } | null)?.written_at;
  const t = typeof w === "string" ? Date.parse(w) : NaN;
  return Number.isNaN(t) ? mtimeMs : t;
}

/** Live `handoff.json` first (vaults in priority order), then the newest valid archive across all vaults. Corrupt files are skipped. */
export function findHandoff(vaults: string[]): FoundHandoff | null {
  const read = (file: string, source: FoundHandoff["source"]): FoundHandoff | null => {
    try {
      const content = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
      return { source, path: file, content, writtenAtMs: writtenAt(content, fs.statSync(file).mtimeMs) };
    } catch {
      return null;
    }
  };
  for (const v of vaults) {
    const live = path.join(v, "handoff.json");
    if (fs.existsSync(live)) {
      const found = read(live, "live");
      if (found) return found;
    }
  }
  const archives = vaults.flatMap((v) => {
    const dir = path.join(v, "handoffs");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => path.join(dir, n));
  });
  const found = archives.map((f) => read(f, "archive")).filter((h): h is FoundHandoff => h !== null);
  return found.sort((a, b) => b.writtenAtMs - a.writtenAtMs)[0] ?? null;
}

/** Moves the live file into `<vault>/handoffs/<utc-date>[-N].json`, never clobbering a same-day archive. Returns the destination. */
export function archiveLiveHandoff(vault: string, livePath: string, now: Date): string {
  const dir = path.join(vault, "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const date = now.toISOString().slice(0, 10);
  let dest = path.join(dir, `${date}.json`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${date}-${n}.json`);
  fs.renameSync(livePath, dest);
  return dest;
}

/** True for a Bash tool_use that runs write-handoff.sh. A substring match is wrong: skill text loaded into the transcript mentions it. */
function runsWriteHandoff(line: string): boolean {
  if (!line.includes("write-handoff.sh") || !line.includes('"tool_use"')) return false;
  try {
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    return Array.isArray(content) && content.some((b: { type?: string; name?: string; input?: { command?: unknown } }) =>
      b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string" && /(^|[\s;&|/"'])write-handoff\.sh\b/.test(b.input.command));
  } catch {
    return false;
  }
}

/** Last activity (transcript mtime), active days, title and handoff-written flag for one registered session. A missing transcript is flagged `transcriptMissing` and falls back to startedAt. */
export function describeSession(record: CaptainSessionRecord): SessionActivity {
  const started = Date.parse(record.startedAt);
  let stat: fs.Stats;
  let text: string;
  try {
    stat = fs.statSync(record.transcriptPath);
    text = fs.readFileSync(record.transcriptPath, "utf-8");
  } catch {
    return { record, lastActivityMs: started, activeDays: [localDay(started)], wroteHandoff: false, transcriptMissing: true };
  }
  const days = new Set<string>([localDay(started), localDay(stat.mtimeMs)]);
  for (const m of text.matchAll(/"timestamp":"([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t)) days.add(localDay(t));
  }
  let title: string | undefined;
  let wroteHandoff = false;
  for (const line of text.split("\n")) {
    if (line.includes('"custom-title"')) {
      try {
        const t = (JSON.parse(line) as { customTitle?: unknown }).customTitle;
        if (typeof t === "string" && t) title = t;
      } catch { /* skip */ }
    } else if (!wroteHandoff && runsWriteHandoff(line)) wroteHandoff = true;
  }
  return { record, lastActivityMs: Math.max(stat.mtimeMs, started), activeDays: [...days].sort(), wroteHandoff, ...(title ? { title } : {}) };
}
