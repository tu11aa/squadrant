// packages/agents/src/claude/api-key-approval.ts
// #775 precondition 3: Claude Code records API-key approve/reject decisions in
// `~/.claude.json` under `customApiKeyResponses`. A key whose last 20 chars sit
// in `rejected` is REFUSED client-side — the session reports "Not logged in"
// with the env perfectly correct. A key in neither list triggers an interactive
// prompt, which an unattended crew cannot answer. Reconcile the routed key into
// `approved` before launching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EnsureApprovedResult {
  changed: boolean;
  /** Present when nothing was written, for an actionable log line. */
  reason?: string;
}

/**
 * Best-effort and idempotent. Never throws — a failure to reconcile must
 * surface as a clear log line, not a silent "Not logged in" (or a crashed spawn).
 */
export function ensureClaudeApiKeyApproved(
  apiKey: string,
  opts: { claudeJsonPath?: string; log?: (m: string) => void } = {},
): EnsureApprovedResult {
  const suffix = apiKey.slice(-20);
  if (!suffix) return { changed: false, reason: "empty api key" };

  const file = opts.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
  const log = opts.log ?? (() => {});
  if (!fs.existsSync(file)) {
    return { changed: false, reason: "no ~/.claude.json yet — skipping routed-key pre-approval" };
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      changed: false,
      reason: "~/.claude.json is not valid JSON — skipped routed-key pre-approval",
    };
  }

  const responses = (doc.customApiKeyResponses ?? {}) as {
    approved?: string[];
    rejected?: string[];
  };
  const approved = Array.isArray(responses.approved) ? [...responses.approved] : [];
  const rejected = Array.isArray(responses.rejected) ? [...responses.rejected] : [];
  const wasRejected = rejected.includes(suffix);
  if (!wasRejected && approved.includes(suffix)) return { changed: false };

  if (!approved.includes(suffix)) approved.push(suffix);
  doc.customApiKeyResponses = {
    ...responses,
    approved,
    rejected: rejected.filter((s) => s !== suffix),
  };

  const tmp = `${file}.squadrant-tmp`;
  try {
    // Atomic write: a crash mid-write must not truncate the live ~/.claude.json
    // (claude stores its own state there), and the original file mode is preserved.
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    return {
      changed: false,
      reason: `could not write ~/.claude.json: ${(e as Error).message} — the routed key may be refused as "Not logged in"`,
    };
  }

  log(
    wasRejected
      ? "claude: pre-approved the routed API key (it was in customApiKeyResponses.rejected — would have reported 'Not logged in')"
      : "claude: pre-approved the routed API key",
  );
  return { changed: true };
}
