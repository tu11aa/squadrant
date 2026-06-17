// src/lib/cmux-config.ts
//
// #348 (part of #332): comment-preserving JSONC merge for the cmux control
// socket auth mode. Writes ONLY `automation.socketControlMode = "automation"`
// into ~/.config/cmux/cmux.json so the launchd cockpit daemon (NOT a cmux
// descendant) may connect to the cmux control socket for daemon-direct delivery.
//
// See docs/specs/2026-06-16-cmux-socket-auth-daemon-direct-design.md §2–§4.1.
//
// We use jsonc-parser (modify + applyEdits) rather than JSON.parse/stringify so
// every existing comment and key in the user's cmux.json survives — cmux itself
// preserves comments and we must not clobber them.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";

/** Canonical cmux config path. cmux watches this file live (§3.2). */
export function defaultCmuxConfigPath(): string {
  return join(homedir(), ".config", "cmux", "cmux.json");
}

export const SOCKET_CONTROL_MODE_PATH = ["automation", "socketControlMode"] as const;
export const AUTOMATION_MODE = "automation";

export interface EnsureSocketAutomationResult {
  /** Absolute path written/inspected. */
  path: string;
  /** True when the file was written this call. */
  changed: boolean;
  /** True when socketControlMode was ALREADY "automation" (no write needed). */
  alreadySet: boolean;
}

// Minimal cockpit-managed template used only when cmux.json does not yet exist
// (clean install before cmux has created its own template). It is a strict
// subset of cmux's schema, so cmux merges its full template keys on next launch
// without conflict.
const MINIMAL_TEMPLATE = [
  `{`,
  `  // [cockpit] file-managed: allow the launchd cockpit daemon to reach the cmux`,
  `  // control socket for daemon-direct notification delivery (#348/#332).`,
  `  "automation": {`,
  `    "socketControlMode": "${AUTOMATION_MODE}"`,
  `  }`,
  `}`,
  ``,
].join("\n");

/**
 * Ensure `automation.socketControlMode = "automation"` in the cmux config.
 *
 * Idempotent: a no-op (changed=false) when already set. Comment- and
 * formatting-preserving when adding/overwriting an existing file. Creates a
 * minimal cockpit-managed file when none exists.
 */
export function ensureSocketAutomation(
  opts: { path?: string } = {},
): EnsureSocketAutomationResult {
  const path = opts.path ?? defaultCmuxConfigPath();

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, MINIMAL_TEMPLATE);
    return { path, changed: true, alreadySet: false };
  }

  const text = readFileSync(path, "utf-8");
  const current = parse(text)?.automation?.socketControlMode;
  if (current === AUTOMATION_MODE) {
    return { path, changed: false, alreadySet: true };
  }

  const edits = modify(text, [...SOCKET_CONTROL_MODE_PATH], AUTOMATION_MODE, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(path, applyEdits(text, edits));
  return { path, changed: true, alreadySet: false };
}
