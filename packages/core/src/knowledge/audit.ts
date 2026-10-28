// packages/core/src/knowledge/audit.ts — append-only audit log for KB item use (#935).
// One JSON line per event, one O_APPEND write each. Never throws: the log must not block a hook or a command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeAuditKb, isKbDomain, kbConfigs, USER_KB, type KbLevel, type Rule, type SquadrantConfig } from "@squadrant/shared";
import type { AuditRecord } from "./fullpass.js";

export type AuditEventName =
  | "item.surfaced" | "item.suppressed" | "item.fallback" | "item.searched" | "item.shown"
  | "item.cited" | "item.outcome"
  | "item.proposed" | "item.approved" | "item.rejected" | "item.applied" | "item.promoted" | "item.superseded" | "item.archived";

export interface AuditEvent {
  kb: string;
  level: string;
  project: string;
  /** KB domain (rules|decisions|wiki|profile). Lines written before #979 may hold a rule category here. */
  domain: string;
  /** Rules: the rule's category (its frontmatter `domain`). */
  category?: string;
  itemId: string;
  event: AuditEventName;
  trigger?: "session" | "prompt" | "tool" | "fallback";
  score?: number;
  chars?: number;
  agent?: string;
  session?: string;
  /** item.searched: the query, truncated to AUDIT_QUERY_CHARS. */
  query?: string;
  /** item.outcome: what the operator or agent reported. */
  outcome?: "followed" | "violated" | "noise" | "wrong";
  /** item.outcome: who graded it (#945). Absent on old records, which read as "operator". */
  source?: OutcomeSource;
  /** The crew task the event belongs to. Delivery events get it from SQUADRANT_CREW_TASK_ID. */
  task?: string;
  /** item.cited: where the id was seen (e.g. "crew-done", "git:<sha>"); with itemId it dedups re-scans. */
  ref?: string;
  /** item.rejected: why (e.g. "ungrounded"). */
  reason?: string;
}

export const OUTCOME_SOURCES = ["operator", "review", "crew", "reconcile", "judge", "check"] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];
/** An outcome's grader; records written before #945 have none and were all operator feedback. */
export const outcomeSource = (e: Record<string, unknown>): string => (typeof e.source === "string" && e.source ? e.source : "operator");
/** Sources whose outcomes count toward followed/violated rates. Crew self-reports are shown, not counted;
 *  reconcile violations measure codebase drift and are reported as codeViolations (spec 2026-10-15 §4 A4/A5). */
export const RATED_SOURCES: ReadonlySet<string> = new Set(["operator", "review", "judge", "check"]);

/** Events that deliver an item to an agent; they carry the crew task so a task's rules can be listed. */
export const DELIVERY_EVENTS: ReadonlySet<string> = new Set(["item.surfaced", "item.shown", "item.searched"]);

/** Test seam: where and when to write, and the env the crew task id is read from. */
export interface AuditSink { dir?: string; now?: () => Date; machineId?: string; env?: NodeJS.ProcessEnv }

export const AUDIT_QUERY_CHARS = 200;

/** `SQUADRANT_AUDIT_DIR` overrides the location (tests, relocated state). */
export const defaultAuditDir = () => process.env.SQUADRANT_AUDIT_DIR || path.join(os.homedir(), ".local", "state", "squadrant", "audit");

/** Stable per-machine tag so synced audit dirs never share a file. */
export const auditMachineId = () => os.hostname().replace(/[^A-Za-z0-9_-]/g, "_") || "host";

export function appendAudit(events: AuditEvent[], sink: AuditSink = {}): void {
  if (!events.length) return;
  try {
    const ts = (sink.now?.() ?? new Date()).toISOString();
    const task = (sink.env ?? process.env).SQUADRANT_CREW_TASK_ID;
    const dir = sink.dir ?? defaultAuditDir();
    const file = path.join(dir, `${ts.slice(0, 7)}.${sink.machineId ?? auditMachineId()}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
      for (const e of events) {
        const q = e.query === undefined ? {} : { query: e.query.slice(0, AUDIT_QUERY_CHARS) };
        const t = task && e.task === undefined && DELIVERY_EVENTS.has(e.event) ? { task } : {};
        fs.writeSync(fd, JSON.stringify({ ts, ...e, ...q, ...t }) + "\n");
      }
    } finally { fs.closeSync(fd); }
  } catch (err) {
    console.error(`squadrant audit: log write failed: ${(err as Error).message}`);
  }
}

/**
 * kb/level/category of a resolved rule from its layer ("project:<p>" | "kb:<name>"). A project-level rule carries its
 * home KB (`repo:<p>` for `repo:docs`), so it is scored with that KB (spec 2026-10-27 §4.5); without `cfg` it is "".
 */
export function ruleAuditScope(rule: Rule, cfg?: SquadrantConfig): { kb: string; level: KbLevel; category: string } {
  if (rule.layer.startsWith("kb:")) return { kb: rule.layer.slice(3), level: "shared", category: rule.domain };
  const project = rule.layer.slice("project:".length);
  return { kb: cfg ? homeAuditKb(cfg, project) : "", level: "project", category: rule.domain };
}

// ── read-side normalization (spec 2026-10-27 §4.6, C4) ──────────────

/** What legacy-line normalization needs from the config: the `kb` values an event may carry, and each project's home label. */
export interface AuditReadCtx { kbs: ReadonlySet<string>; home: (project: string) => string }

/** Valid `kb` values: configured KBs, `_user`, and every project's home label (a home KB or `repo:<p>`). */
export function auditReadCtx(cfg: SquadrantConfig): AuditReadCtx {
  const kbs = new Set([...Object.keys(kbConfigs(cfg)), USER_KB]);
  for (const p of Object.keys(cfg.projects)) { const h = homeAuditKb(cfg, p); if (h) kbs.add(h); }
  return { kbs, home: (p) => (cfg.projects[p] ? homeAuditKb(cfg, p) : "") };
}

/**
 * One audit line as it reads today; the log itself is never rewritten. A `domain` outside the four KB domains is a
 * pre-#979 rule category → `domain: "rules"` + `category`; `level: "group"` → `shared`; `kb: ""` takes the project's
 * home label ("" when it has none: the `(no home)` group). Null when `kb` is a value no config or project has (the
 * `kb: "t"` test leak): such lines are ignored and counted by `auditHealth`.
 */
export function normalizeAuditRecord(r: AuditRecord, ctx: AuditReadCtx): AuditRecord | null {
  const project = typeof r.project === "string" ? r.project : "";
  const kb = typeof r.kb === "string" && r.kb ? r.kb : project ? ctx.home(project) : "";
  if (kb && !ctx.kbs.has(kb)) return null;
  const domain = typeof r.domain === "string" ? r.domain : "";
  const legacy = isKbDomain(domain) ? {} : { domain: "rules", ...(domain && r.category === undefined ? { category: domain } : {}) };
  return { ...r, kb, ...(r.level === "group" ? { level: "shared" } : {}), ...legacy };
}

export const auditNormalizer = (cfg: SquadrantConfig) => {
  const ctx = auditReadCtx(cfg);
  return (r: AuditRecord) => normalizeAuditRecord(r, ctx);
};
