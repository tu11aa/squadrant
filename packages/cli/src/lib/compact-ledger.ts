// #1015: the live crew ledger a captain gets back after a /compact — what its crews are
// doing and which messages are still queued for it. Pure: the hook gathers the inputs.
import type { MailboxEntry } from "@squadrant/core";
import type { LiveCrewSummary } from "./handoff-facts.js";

export const LEDGER_MAX_CHARS = 4000;
const PREVIEW_CHARS = 100;
const PREVIEW_ENTRIES = 5;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const SUMMARY_CHARS = 120;

/** What the crew is for: the first `#N` and the title text after it, else the first non-heading line of the brief. */
export function taskSummary(task: string): string {
  const issue = /#\d+[^\r\n]*/.exec(task)?.[0];
  if (issue) return clip(oneLine(issue.includes("(") ? issue : issue.replace(/[)\s]+$/, "")), SUMMARY_CHARS);
  const lines = task.split(/\r?\n/).map((l) => l.replace(/^[\s>*-]+/, "").trim()).filter(Boolean);
  return clip(oneLine(lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? ""), SUMMARY_CHARS);
}

function crewLine(c: LiveCrewSummary): string {
  const label = c.reviewStage === "pr-open" ? "awaiting human review"
    : c.state === "done" && c.tabOpen ? "done: awaiting captain review"
    : c.state;
  const parts = [`- ${c.name} [${label}]`];
  const summary = taskSummary(c.task ?? "");
  if (summary) parts.push(summary);
  if (c.branch) parts.push(`branch ${c.branch}`);
  if (c.prUrl) parts.push(`PR ${c.prUrl}`);
  if (c.operatorHold) parts.push("operator hold");
  // The open question is the one thing that must survive verbatim — a paraphrase is a lost question.
  if (c.question) parts.push(`question: "${c.question}"`);
  if (c.reviewNote) parts.push(`review note: ${clip(oneLine(c.reviewNote), 300)}`);
  return parts.join(" | ");
}

function mailLine(e: MailboxEntry): string {
  const text = oneLine(e.message ?? String(e.payload?.text ?? ""));
  return `  #${e.seq} ${e.kind}${e.name ? ` (${e.name})` : ""}: ${clip(text, PREVIEW_CHARS)}`;
}

/** "" when there is nothing to report. Bounded to `maxChars`, with the truncation stated. */
export function renderLiveLedger(crews: LiveCrewSummary[], undelivered: MailboxEntry[], maxChars = LEDGER_MAX_CHARS): string {
  if (crews.length === 0 && undelivered.length === 0) return "";
  const lines = ["Live crew ledger (daemon state at compact time):"];
  lines.push(...(crews.length ? crews.map(crewLine) : ["- no live crews"]));
  if (undelivered.length) {
    lines.push(`Undelivered mailbox: ${undelivered.length} message(s) still queued — they arrive after this context, in order:`);
    lines.push(...undelivered.slice(0, PREVIEW_ENTRIES).map(mailLine));
    if (undelivered.length > PREVIEW_ENTRIES) lines.push(`  …and ${undelivered.length - PREVIEW_ENTRIES} more`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[ledger truncated at ${maxChars} chars — run \`squadrant handoff facts\` for the full picture]`;
}
