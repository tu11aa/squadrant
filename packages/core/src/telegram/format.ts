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
