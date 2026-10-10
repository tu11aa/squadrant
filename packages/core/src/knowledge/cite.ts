// packages/core/src/knowledge/cite.ts — item.cited: a rule id in a DONE / handoff / commit message after it was
// surfaced or shown (KB spec §7, #901). Only ids the audit log shows were delivered can be cited, so a stray
// word that happens to equal an id in a project the agent never saw does not count.
import { appendAudit, defaultAuditDir, type AuditSink } from "./audit.js";
import { readAuditRecords, type AuditRecord } from "./fullpass.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CITE_LOOKBACK_DAYS = 7;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An id is cited when it appears as a whole token (ids contain `.` and `-`). */
export const mentionsId = (text: string, id: string) => new RegExp(`(?<![\\w.-])${escapeRe(id)}(?![\\w-])`).test(text);

export interface CiteScanInput {
  text: string;
  /** Where the text came from, e.g. "crew-done", "git:<sha>": dedups re-scans. */
  ref: string;
  project: string;
  /** Narrow to one agent session when known; otherwise any session of the project in the lookback. */
  session?: string;
  agent?: string;
  /** Timestamp the text was written (default now). Only deliveries before it count. */
  at?: Date;
  lookbackDays?: number;
  sink?: AuditSink;
}

/** Log item.cited for each delivered id named in `text`. Returns the ids newly cited. */
export function scanAndLogCitations(i: CiteScanInput): string[] {
  const at = i.at ?? i.sink?.now?.() ?? new Date();
  const since = new Date(at.getTime() - (i.lookbackDays ?? CITE_LOOKBACK_DAYS) * DAY_MS);
  const dir = i.sink?.dir ?? defaultAuditDir();
  const delivered = new Map<string, AuditRecord>();
  const already = new Set<string>();
  for (const r of readAuditRecords(undefined, since, dir)) {
    if (!r.itemId || r.project !== i.project) continue;
    if (r.event === "item.cited" && r.ref === i.ref) already.add(r.itemId);
    if (!(r.event === "item.surfaced" || r.event === "item.shown") || Date.parse(r.ts) > at.getTime()) continue;
    if (i.session && r.session && r.session !== i.session) continue;
    delivered.set(r.itemId, r);
  }
  const hits = [...delivered].filter(([id]) => !already.has(id) && mentionsId(i.text, id));
  appendAudit(hits.map(([itemId, r]) => ({
    kb: String(r.kb ?? ""), level: String(r.level ?? "project"), project: i.project, domain: String(r.domain ?? "rules"),
    itemId, event: "item.cited" as const, ref: i.ref, ...(i.agent ? { agent: i.agent } : {}), ...(i.session ? { session: i.session } : {}),
  })), i.sink);
  return hits.map(([id]) => id);
}

/** Commit messages since a date in `repo`, one `{sha, at, text}` each. */
export function readGitMessages(repo: string, since: Date, run: (args: string[]) => string): { sha: string; at: Date; text: string }[] {
  const out = run(["-C", repo, "log", `--since=${since.toISOString()}`, "--format=%x1e%H%x1f%cI%x1f%B"]);
  return out.split("\x1e").filter((c) => c.trim()).map((c) => {
    const [sha, at, ...rest] = c.split("\x1f");
    return { sha: sha.trim(), at: new Date(at), text: rest.join("\x1f") };
  });
}
