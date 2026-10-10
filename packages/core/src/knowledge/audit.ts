// packages/core/src/knowledge/audit.ts — append-only audit log for KB item use (#935).
// One JSON line per event, one O_APPEND write each. Never throws: the log must not block a hook or a command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Rule } from "@squadrant/shared";

export type AuditEventName =
  | "item.surfaced" | "item.suppressed" | "item.searched" | "item.shown"
  | "item.proposed" | "item.superseded" | "item.applied" | "item.rejected";

export interface AuditEvent {
  kb: string;
  level: string;
  project: string;
  domain: string;
  itemId: string;
  event: AuditEventName;
  trigger?: "session" | "prompt" | "tool";
  score?: number;
  chars?: number;
  agent?: string;
  session?: string;
  /** item.searched: the query, truncated to AUDIT_QUERY_CHARS. */
  query?: string;
  /** item.rejected: why (e.g. "ungrounded"). */
  reason?: string;
}

/** Test seam: where and when to write. */
export interface AuditSink { dir?: string; now?: () => Date; machineId?: string }

export const AUDIT_QUERY_CHARS = 200;

/** `SQUADRANT_AUDIT_DIR` overrides the location (tests, relocated state). */
export const defaultAuditDir = () => process.env.SQUADRANT_AUDIT_DIR || path.join(os.homedir(), ".local", "state", "squadrant", "audit");

/** Stable per-machine tag so synced audit dirs never share a file. */
export const auditMachineId = () => os.hostname().replace(/[^A-Za-z0-9_-]/g, "_") || "host";

export function appendAudit(events: AuditEvent[], sink: AuditSink = {}): void {
  if (!events.length) return;
  try {
    const ts = (sink.now?.() ?? new Date()).toISOString();
    const dir = sink.dir ?? defaultAuditDir();
    const file = path.join(dir, `${ts.slice(0, 7)}.${sink.machineId ?? auditMachineId()}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
      for (const e of events) {
        const q = e.query === undefined ? {} : { query: e.query.slice(0, AUDIT_QUERY_CHARS) };
        fs.writeSync(fd, JSON.stringify({ ts, ...e, ...q }) + "\n");
      }
    } finally { fs.closeSync(fd); }
  } catch (err) {
    console.error(`squadrant audit: log write failed: ${(err as Error).message}`);
  }
}

/** kb/level of a resolved rule from its layer ("project:<p>" | "kb:<name>"). */
export function ruleAuditScope(rule: Rule): { kb: string; level: string } {
  return rule.layer.startsWith("kb:") ? { kb: rule.layer.slice(3), level: "group" } : { kb: "", level: "project" };
}
