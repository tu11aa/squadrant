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
// For a Claude receiver the peer channel additionally wraps the text in Claude
// Code's `<cross-session-message from-name="…">` envelope (`wrapClaudeEnvelope`)
// so the TUI collapses it to `› Message from @crew-mcpspike: 📨 …` (spike #1029).
//
// Framing is applied at delivery time and never persisted (the mailbox keeps the
// bare text), so a retry re-frames from the stored entry and cannot double-wrap.

import type { MailboxEntry } from "./mailbox.js";

export const FRAME_MARK = "📨";

export interface FrameMeta {
  /** `<role>:<name>` (crew:x, captain:proj, thread:id, side:x, telegram:@user) or a bare `daemon` / `cli`. */
  from: string;
  /** The receiving project. */
  project?: string;
  /** Sender's project, when known; else inferred from `captain:<project>` / `crew:<project>/<name>`. A different project adds a reply hint. */
  senderProject?: string;
  /** Event / message kind, e.g. `task.done` (shown as the status `done`); `captain.message` adds nothing and is omitted. */
  kind?: string;
  /** Short task id. */
  task?: string;
  /** Mailbox seq. */
  id?: string | number;
  /** Replaces the kind-derived verb (e.g. `blocked reminder` read from the lifecycle body). */
  verb?: string;
  /** How long a queued message sat before delivery, e.g. `1d 23h`. */
  stale?: string;
  /** Suppress the cross-project reply hint (a dispatched crew reports through its own captain, not by pinging). */
  noReply?: boolean;
}

/** Header values keep a conservative charset — nothing that can break the single line or forge a second header.
 *  Status text may also hold spaces and the two warning markers lifecycle bodies lead with (⚠️ 🔁). */
function clean(v: string | number, allowSpace = false): string {
  return String(v).replace(allowSpace ? /[^A-Za-z0-9_.:@/+ \u26A0\uFE0F\u{1F501}-]/gu : /[^A-Za-z0-9_.:@/+-]/g, "_").slice(0, 80);
}

/** A body line that starts with the header mark is quoted (`│ `), text intact, so it cannot pose as a second header;
 *  an envelope tag in the body (`<cross-session-message`, `</cross-session-message>`) gets `‹` for `<`, so a body
 *  cannot close or forge the Claude envelope. Everything stays readable. */
function escapeBody(body: string): string {
  return body
    .replace(new RegExp(`^([ \\t]*)(${FRAME_MARK})`, "gmu"), "$1│ $2")
    .replace(/<(\s*\/?\s*cross-session-message)/gi, "‹$1");
}

function verbOf(kind: string): string {
  return kind.replace(/^task\./, "");
}

/** `captain:<p>` → p; `crew:<p>/<name>` → p. */
function inferSenderProject(from: string): string | undefined {
  return from.match(/^captain:(.+)$/)?.[1] ?? from.match(/^crew:([^/]+)\//)?.[1];
}

export function frameMessage(meta: FrameMeta, body: string): string {
  const sender = clean(meta.from);
  const label = meta.verb ?? (meta.kind && meta.kind !== "captain.message" ? verbOf(meta.kind) : undefined);
  const parts = [label ? `${sender} → ${clean(label, true)}` : sender];
  if (meta.task) parts.push(`taskId: ${clean(meta.task)}`);
  if (meta.id !== undefined && meta.id !== "") parts.push(`seq: ${clean(meta.id)}`);
  if (meta.stale) parts.push(`stale: ${clean(meta.stale, true)}`);
  const senderProject = meta.senderProject ?? inferSenderProject(meta.from);
  if (!meta.noReply && senderProject && meta.project && senderProject !== meta.project) {
    parts.push(`reply: squadrant ping ${clean(senderProject)} "<msg>"`);
  }
  return `${FRAME_MARK} ${parts.join(" · ")}\n${escapeBody(body)}`;
}

/** Whether a CLI/user-supplied sender label is acceptable as a `from` value. */
export function isValidSender(s: string): boolean {
  return /^[a-z][a-z0-9-]*(:[A-Za-z0-9_.-]+)?$/.test(s) && !RESERVED_NAME.test(s.split(":")[0]);
}

/** Labels that imitate the user, the harness or the model — never a legitimate peer name. */
const RESERVED_NAME = /^(user|system|you|me|claude|anthropic|operator|assistant|human|admin|root)$/i;

/** Longest `@name` the Claude TUI shows before truncating. */
const ENVELOPE_NAME_MAX = 20;

/** Sender label → envelope name: fixed prefix (`crew-…`, `captain-…`, `telegram-…`, `squadrant`), never `user`/`system`-like. */
function envelopeName(sender: string): string {
  if (sender === "daemon") return "squadrant";
  const name = sender
    .replace(/[:/]+/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, ENVELOPE_NAME_MAX) || "squadrant";
  return RESERVED_NAME.test(name) ? `peer-${name}`.slice(0, ENVELOPE_NAME_MAX) : name;
}

/** Header kinds of a FIRST TURN (`frameFirstTurn`): the agent's own instructions, never enveloped as a peer message. */
const FIRST_TURN_HEADER = /^📨 \S+ → (?:task|side\.open|thread\.open|thread\.resume)(?: |$)/mu;

/**
 * Wrap framed text in Claude Code's cross-session envelope so the TUI renders
 * `› Message from @<name>: <first line>`. Format pinned by the #1029 atname spike
 * (Claude Code 2.1.310): `\n` after the open tag and before the close tag; no
 * `from=` (never advertise the daemon socket) and never `from-mode` (a wrong
 * attestation makes an auto-mode receiver hold every message). Text without a
 * `📨` header (free text) is returned untouched, and so is a FIRST TURN (`→ task`,
 * `→ side.open`, `→ thread.open|resume`): auto mode treats everything inside a
 * cross-session envelope as "never user intent", and a crew must not distrust its
 * own task brief. The envelope is cosmetic: if a Claude version stops matching it,
 * the tags show as literal text.
 */
export function wrapClaudeEnvelope(text: string): string {
  const m = text.match(new RegExp(`^${FRAME_MARK} ([^ \\n]+)`, "u"));
  if (!m || FIRST_TURN_HEADER.test(text.split("\n")[0])) return text;
  return `<cross-session-message from-name="${envelopeName(m[1])}">\n${text}\n</cross-session-message>`;
}

/** `[⚠️|🔁 ]CREW <VERB> [provider/name · shortId]:` (or ` —`) — the header carries the sender, verb and task id; a leading marker is kept in the status. */
const LIFECYCLE_PREFIX = /^(?:(⚠️|🔁) )?CREW ([A-Z]+(?:[ -][A-Z]+)*) \[([^\]]*)\](?::| —)[ \t]*/u;

/**
 * Frame a mailbox entry for delivery to its project's captain. The sender comes
 * from the entry itself: a task event is `crew:<name>` (`crew:<project>/<name>`
 * when the crew belongs to another project — a delegation report-back); an
 * external captain.message carries its own `payload.from` (thread:<id>,
 * side:<name>, telegram:@user, …) or falls back to its `payload.source`
 * (telegram / daemon / cli). `payload.stale` (set by the backlog pass) becomes a
 * header field. A lifecycle body's `CREW <VERB> [tag]:` prefix is folded into the
 * header (verb kept).
 */
export function frameEntry(project: string, entry: MailboxEntry, body: string): string {
  const p = entry.payload ?? {};
  const stale = typeof p.stale === "string" && p.stale ? p.stale : undefined;
  if (entry.kind === "captain.message") {
    const from = typeof p.from === "string" && p.from ? p.from : typeof p.source === "string" && p.source ? p.source : "daemon";
    return frameMessage({ from, project, kind: entry.kind, id: entry.seq, stale }, body);
  }
  const short = entry.taskId?.slice(0, 8);
  const fromProject = typeof p.fromProject === "string" && p.fromProject ? p.fromProject : undefined;
  let verb: string | undefined;
  const m = body.match(LIFECYCLE_PREFIX);
  if (m && short && m[3].includes(short)) {
    verb = `${m[1] ? `${m[1]} ` : ""}${m[2].toLowerCase()}`;
    body = body.slice(m[0].length);
  }
  const crew = entry.name ?? short ?? "unknown";
  return frameMessage({
    from: `crew:${fromProject ? `${fromProject}/` : ""}${crew}`,
    project,
    kind: entry.kind,
    verb,
    task: short,
    id: entry.seq,
    stale,
  }, body);
}

/**
 * Frame a FIRST TURN (crew task brief + completion protocol, headless task, side / thread
 * opening turn) so the agent sees who gave it: `📨 captain:<project> → task · taskId: …`.
 * A dispatched crew (`originProject` set and different) names the origin project's captain
 * as sender; no reply hint — the crew reports through its own captain / completion protocol.
 * Frame AFTER any spill-to-file (the pointer line is what gets pasted).
 */
export function frameFirstTurn(
  text: string,
  o: { project: string; originProject?: string; taskId?: string; kind?: string },
): string {
  return frameMessage(
    { from: `captain:${o.originProject ?? o.project}`, project: o.project, kind: o.kind ?? "task", task: o.taskId?.slice(0, 8), noReply: true },
    text,
  );
}
