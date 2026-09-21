// Pure formatters for the Telegram bridge. No I/O, no side effects.
import type { ControlEvent } from "@squadrant/shared";
import type { ProjectUsage } from "../router/usage-ledger.js";

/** Forum-topic title for a project. v1 uses the project name verbatim. */
export function topicName(project: string): string {
  return project;
}

/** Outbound text pushed to a project's Telegram topic for a lifecycle event. */
export function formatLifecycle(project: string, ev: ControlEvent): string {
  switch (ev.type) {
    case "task.done":
      return `✅ [${project}] CREW DONE · ${ev.id}` + (ev.message ? `\n${ev.message}` : "");
    case "task.blocked":
      return `🚧 [${project}] CREW BLOCKED · ${ev.id}\n${ev.question}`;
    case "task.review":
      return `👀 [${project}] CREW REVIEW · ${ev.id}` + (ev.message ? `\n${ev.message}` : "");
    case "task.idle":
      return `💤 [${project}] CREW IDLE · ${ev.id}`;
    case "task.failed":
      return `❌ [${project}] CREW FAILED · ${ev.id}\n${ev.error}`;
    case "task.approval.requested":
      return `🔐 [${project}] APPROVAL NEEDED · ${ev.id}\n${ev.question}`;
    case "task.input.requested":
      return `❓ [${project}] INPUT NEEDED · ${ev.id}\n${ev.question}`;
    case "task.timeout":
      return `⏱️ [${project}] CREW TIMEOUT · ${ev.id}`;
    default:
      return `ℹ️ [${project}] ${ev.type} · ${ev.id}`;
  }
}

/** Captain-pane rendering of an inbound Telegram reply — labeled as external. */
export function formatInbound(text: string): string {
  return `📩 [from Telegram] ${text}`;
}

/** The Telegram attachment fields the bridge inspects (#768). Presence of any
 *  one means the message carried media that cannot be forwarded into a captain
 *  pane — only its text/caption can. */
export interface InboundMedia {
  photo?: unknown;
  voice?: unknown;
  video_note?: unknown;
  video?: unknown;
  audio?: unknown;
  document?: unknown;
  animation?: unknown;
  sticker?: unknown;
}

/** Examined in this order; Telegram sets at most one of them. */
const MEDIA_KINDS: Array<[keyof InboundMedia, string]> = [
  ["photo", "photo"],
  ["voice", "voice message"],
  ["video_note", "video message"],
  ["video", "video"],
  ["audio", "audio file"],
  ["document", "document"],
  ["animation", "animation"],
  ["sticker", "sticker"],
];

/** Name of the attachment an inbound message carried, or undefined for a plain
 *  text message. */
export function mediaKind(m: InboundMedia): string | undefined {
  for (const [field, name] of MEDIA_KINDS) {
    if (m[field] !== undefined) return name;
  }
  return undefined;
}

/** The line added to a captain message for content we deliberately do NOT
 *  forward (#768). It names the attachment AND says it did not come through, so
 *  the captain asks for it another way instead of assuming the message was
 *  complete. */
export function mediaMarker(kind: string): string {
  return `[${kind} attached - not forwarded]`;
}

/** The captain-facing body of an inbound message: its text/caption, plus the
 *  #768 marker when media accompanied it (a caption alone would otherwise read
 *  as the whole message). Empty only when the caller passed neither — callers
 *  guarantee at least one. */
export function inboundBody(text: string | undefined, kind: string | undefined): string {
  if (kind === undefined) return text ?? "";
  const marker = mediaMarker(kind);
  return text ? `${text}\n${marker}` : marker;
}

/** Operator-facing receipt for an attachment we did not forward (#768). A file
 *  that never arrives must not look like one that did, so the line says exactly
 *  what reached the captain and what did not. */
export function formatMediaReceipt(kind: string, hasCaption: boolean): string {
  return hasCaption
    ? `📎 ${kind} not forwarded — your caption reached the captain`
    : `📎 ${kind} not forwarded — the captain was told it arrived, nothing else was sent`;
}

/** One-line routed-cost summary for a project, appended to terminal crew events.
 *  Cost is accumulated per project (the router token is per-project, U1) and
 *  grouped by model; the top model by cost is named, with `+N` for the rest. */
export function formatUsageLine(u: ProjectUsage): string {
  const reqs = u.requests === 1 ? "1 req" : `${u.requests} reqs`;
  const named = Object.keys(u.models)
    .filter((m) => m !== "unknown")
    .sort((a, b) => u.models[b].costUsd - u.models[a].costUsd);
  const suffix =
    named.length === 1 ? ` · ${named[0]}` : named.length > 1 ? ` · ${named[0]} +${named.length - 1}` : "";
  return `💰 $${u.costUsd.toFixed(4)} · ${reqs}${suffix}`;
}

/** Mask all but the last 4 characters of a bot token for safe display. */
export function maskToken(token: string): string {
  if (token.length <= 4) return token;
  return "*".repeat(token.length - 4) + token.slice(-4);
}
