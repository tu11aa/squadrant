// packages/core/src/knowledge/cite.ts — item.cited: a rule id in a DONE / handoff / commit message after it was
// surfaced, shown or returned by a search (KB spec §7, #901). Only ids the audit log shows were delivered can be cited, so a stray
// word that happens to equal an id in a project the agent never saw does not count.
import { appendAudit, defaultAuditDir, type AuditEvent, type AuditSink } from "./audit.js";
import { readAuditRecords, type AuditRecord } from "./fullpass.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CITE_LOOKBACK_DAYS = 7;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An id is cited when it appears as a whole token (ids contain `.` and `-`). */
export const mentionsId = (text: string, id: string) => new RegExp(`(?<![\\w.-])${escapeRe(id)}(?![\\w-])`).test(text);

export interface CiteText {
  text: string;
  /** Where the text came from, e.g. "crew-done", "git:<sha>": dedups re-scans. */
  ref: string;
  /** Timestamp the text was written (default now). Only deliveries before it count. */
  at?: Date;
}
export interface CiteScanOptions {
  project: string;
  /** Narrow to one agent session when known; otherwise any session of the project in the lookback. */
  session?: string;
  agent?: string;
  lookbackDays?: number;
  sink?: AuditSink;
}
export type CiteScanInput = CiteText & CiteScanOptions;

/** Log item.cited for each delivered id named in `text`. Returns the ids newly cited. */
export function scanAndLogCitations(i: CiteScanInput): string[] {
  return scanCitations([i], i);
}

/** Batch form: reads the audit log once for all texts. Returns one id per new (ref, id) citation, in text order. */
export function scanCitations(texts: CiteText[], o: CiteScanOptions): string[] {
  if (!texts.length) return [];
  const now = o.sink?.now?.() ?? new Date();
  const lookbackMs = (o.lookbackDays ?? CITE_LOOKBACK_DAYS) * DAY_MS;
  const ats = texts.map((t) => (t.at ?? now).getTime());
  const records = readAuditRecords(undefined, new Date(Math.min(...ats) - lookbackMs), o.sink?.dir ?? defaultAuditDir())
    .filter((r) => r.itemId && r.project === o.project);
  const already = new Set(records.filter((r) => r.event === "item.cited").map((r) => `${r.ref}|${r.itemId}`));
  const deliveries = records.filter((r) => (r.event === "item.surfaced" || r.event === "item.shown" || r.event === "item.searched")
    && !(o.session && r.session && r.session !== o.session));
  const events: AuditEvent[] = [];
  texts.forEach((t, n) => {
    const at = ats[n];
    const delivered = new Map<string, AuditRecord>();
    for (const r of deliveries) {
      const ts = Date.parse(r.ts);
      if (ts <= at && ts >= at - lookbackMs) delivered.set(r.itemId!, r);
    }
    for (const [itemId, r] of delivered) {
      if (already.has(`${t.ref}|${itemId}`) || !mentionsId(t.text, itemId)) continue;
      already.add(`${t.ref}|${itemId}`);
      events.push({
        kb: String(r.kb ?? ""), level: String(r.level ?? "project"), project: o.project, domain: String(r.domain ?? "rules"),
        itemId, event: "item.cited", ref: t.ref, ...(o.agent ? { agent: o.agent } : {}), ...(o.session ? { session: o.session } : {}),
      });
    }
  });
  appendAudit(events, o.sink);
  return events.map((e) => e.itemId);
}

export interface GitMessage { sha: string; at: Date; text: string }
const LOG_FORMAT = "--format=%x1e%H%x1f%cI%x1f%B";

/** Commit messages since a date on every local branch of `repo` (crew commits sit on unmerged branches), one `{sha, at, text}` each. */
export function readGitMessages(repo: string, since: Date, run: (args: string[]) => string): GitMessage[] {
  return parseLog(run(["-C", repo, "log", "--all", `--since=${since.toISOString()}`, LOG_FORMAT]));
}

/** The current branch's own commits, newest first: reachable from HEAD but from no other local branch and no remote
 *  ref except this branch's own (e.g. origin/<branch> after a push). No base branch needed. Empty outside a repo. */
export function readBranchOnlyMessages(repo: string, run: (args: string[]) => string, max = 200): GitMessage[] {
  const branch = run(["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!branch) return [];
  const own = branch === "HEAD" ? [] : [`--exclude=${branch}`];
  return parseLog(run(["-C", repo, "log", `--max-count=${max}`, "HEAD", "--not", ...own, "--branches", ...(own.length ? [`--exclude=*/${branch}`] : []), "--remotes", LOG_FORMAT]));
}

function parseLog(out: string): GitMessage[] {
  return out.split("\x1e").filter((c) => c.trim()).map((c) => {
    const [sha, at, ...rest] = c.split("\x1f");
    return { sha: sha.trim(), at: new Date(at), text: rest.join("\x1f") };
  });
}
