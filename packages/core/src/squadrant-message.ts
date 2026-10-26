// Sender framing for every message squadrant types into an agent session.
//
// Claude Code (and others) wrap socket-delivered input as an anonymous
// "Another Claude session sent a message", ignoring any sender name the
// transport carries (#1029 spike). The only agent-neutral way to show who sent
// a message is in the body, so the delivery layer wraps it once:
//
//   <squadrant-message from="crew:mcpspike" project="squadrant" kind="task.done">
//   CREW DONE [claude/mcpspike · 66884473]: …
//   </squadrant-message>
//
// Framing is applied at delivery time and never persisted (the mailbox keeps the
// bare text), so a retry re-frames from the stored entry and cannot double-wrap.

import type { MailboxEntry } from "./mailbox.js";

export const FRAME_TAG = "squadrant-message";

export interface FrameMeta {
  /** `<role>:<name>` (crew:x, captain:proj, thread:id, side:x) or a bare `daemon` / `telegram` / `cli`. */
  from: string;
  project?: string;
  /** Event / message kind, e.g. `task.done`, `captain.message`. */
  kind?: string;
  agent?: string;
  task?: string;
  /** Mailbox seq. */
  id?: string | number;
}

const ATTR_ORDER = ["from", "project", "kind", "agent", "task", "id"] as const;

/** Attribute values keep a conservative charset — nothing that can close the quote or the tag. */
function cleanAttr(v: string | number): string {
  return String(v).replace(/[^A-Za-z0-9_.:@/+-]/g, "_").slice(0, 80);
}

/** Neutralize any opening/closing frame tag inside the body so it cannot end the frame or forge a sender. */
function escapeBody(body: string): string {
  return body.replace(new RegExp(`<(\\s*/?\\s*${FRAME_TAG})`, "gi"), "&lt;$1");
}

export function frameMessage(meta: FrameMeta, body: string): string {
  const attrs = ATTR_ORDER
    .filter((k) => meta[k] !== undefined && meta[k] !== "")
    .map((k) => `${k}="${cleanAttr(meta[k]!)}"`)
    .join(" ");
  return `<${FRAME_TAG} ${attrs}>\n${escapeBody(body)}\n</${FRAME_TAG}>`;
}

/** Whether a CLI/user-supplied sender label is acceptable as a `from` value. */
export function isValidSender(s: string): boolean {
  return /^[a-z][a-z0-9-]*(:[A-Za-z0-9_.-]+)?$/.test(s);
}

/**
 * Frame a mailbox entry for delivery to its project's captain. The sender comes
 * from the entry itself: a task event is `crew:<name>`; an external
 * captain.message carries its own `payload.from` (thread:<id>, side:<name>, …)
 * or falls back to its `payload.source` (telegram / daemon / cli).
 */
export function frameEntry(project: string, entry: MailboxEntry, body: string): string {
  const p = entry.payload ?? {};
  if (entry.kind === "captain.message") {
    const from = typeof p.from === "string" && p.from ? p.from : typeof p.source === "string" && p.source ? p.source : "daemon";
    return frameMessage({ from, project, kind: entry.kind, id: entry.seq }, body);
  }
  const short = entry.taskId?.slice(0, 8);
  return frameMessage({
    from: `crew:${entry.name ?? short ?? "unknown"}`,
    project,
    kind: entry.kind,
    agent: entry.provider,
    task: short,
    id: entry.seq,
  }, body);
}
