// Sender framing for every message squadrant types into an agent session.
//
// Claude Code (and others) wrap socket-delivered input as an anonymous
// "Another Claude session sent a message", ignoring any sender name the
// transport carries (#1029 spike). The only agent-neutral way to show who sent
// a message is in the body, so the delivery layer prepends ONE compact header
// line (no XML — it is read in a terminal):
//
//   📨 crew:mcpspike → done · taskId: 66884473 · seq: 12
//   merged into #245 …
//
// Framing is applied at delivery time and never persisted (the mailbox keeps the
// bare text), so a retry re-frames from the stored entry and cannot double-wrap.

import type { MailboxEntry } from "./mailbox.js";

export const FRAME_MARK = "📨";

export interface FrameMeta {
  /** `<role>:<name>` (crew:x, captain:proj, thread:id, side:x) or a bare `daemon` / `telegram` / `cli`. */
  from: string;
  /** The receiving project. The header names a project only when the sender's differs. */
  project?: string;
  /** Sender's project, when known; else inferred from a `captain:<project>` sender. */
  senderProject?: string;
  /** Event / message kind, e.g. `task.done` (shown as the status `done`); `captain.message` adds nothing and is omitted. */
  kind?: string;
  /** Shown only when it is not the default `claude`. */
  agent?: string;
  /** Short task id. */
  task?: string;
  /** Mailbox seq. */
  id?: string | number;
  /** Replaces the kind-derived verb (e.g. `blocked reminder` read from the lifecycle body). */
  verb?: string;
}

/** Header values keep a conservative charset — nothing that can break the single line or forge a second header. */
function clean(v: string | number, allowSpace = false): string {
  return String(v).replace(allowSpace ? /[^A-Za-z0-9_.:@/+ -]/g : /[^A-Za-z0-9_.:@/+-]/g, "_").slice(0, 80);
}

/** Neutralize any body line that starts with the header mark so it cannot pose as a second header. */
function escapeBody(body: string): string {
  return body.replace(new RegExp(`^([ \\t]*)${FRAME_MARK}`, "gmu"), "$1\\" + FRAME_MARK);
}

function verbOf(kind: string): string {
  return kind.replace(/^task\./, "");
}

export function frameMessage(meta: FrameMeta, body: string): string {
  const sender = clean(meta.from) + (meta.agent && meta.agent !== "claude" ? ` (${clean(meta.agent)})` : "");
  const label = meta.verb ?? (meta.kind && meta.kind !== "captain.message" ? verbOf(meta.kind) : undefined);
  const parts = [label ? `${sender} → ${clean(label, true)}` : sender];
  if (meta.task) parts.push(`taskId: ${clean(meta.task)}`);
  if (meta.id !== undefined && meta.id !== "") parts.push(`seq: ${clean(meta.id)}`);
  const senderProject = meta.senderProject ?? meta.from.match(/^captain:(.+)$/)?.[1];
  if (senderProject && senderProject !== meta.project) parts.push(clean(senderProject));
  return `${FRAME_MARK} ${parts.join(" · ")}\n${escapeBody(body)}`;
}

/** Whether a CLI/user-supplied sender label is acceptable as a `from` value. */
export function isValidSender(s: string): boolean {
  return /^[a-z][a-z0-9-]*(:[A-Za-z0-9_.-]+)?$/.test(s);
}

/** `CREW <VERB> [provider/name · shortId]: ` — the header already carries the sender, verb and task id. */
const LIFECYCLE_PREFIX = /^CREW ([A-Z]+(?: [A-Z]+)*) \[([^\]]*)\]:[ \t]*/;

/**
 * Frame a mailbox entry for delivery to its project's captain. The sender comes
 * from the entry itself: a task event is `crew:<name>`; an external
 * captain.message carries its own `payload.from` (thread:<id>, side:<name>, …)
 * or falls back to its `payload.source` (telegram / daemon / cli). A lifecycle
 * body's `CREW <VERB> [tag]:` prefix is folded into the header (verb kept).
 */
export function frameEntry(project: string, entry: MailboxEntry, body: string): string {
  const p = entry.payload ?? {};
  if (entry.kind === "captain.message") {
    const from = typeof p.from === "string" && p.from ? p.from : typeof p.source === "string" && p.source ? p.source : "daemon";
    return frameMessage({ from, project, kind: entry.kind, id: entry.seq }, body);
  }
  const short = entry.taskId?.slice(0, 8);
  let verb: string | undefined;
  const m = body.match(LIFECYCLE_PREFIX);
  if (m && short && m[2].includes(short)) {
    verb = m[1].toLowerCase();
    body = body.slice(m[0].length);
  }
  return frameMessage({
    from: `crew:${entry.name ?? short ?? "unknown"}`,
    project,
    kind: entry.kind,
    verb,
    agent: entry.provider,
    task: short,
    id: entry.seq,
  }, body);
}
