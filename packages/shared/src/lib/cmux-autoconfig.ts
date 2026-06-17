// src/lib/cmux-autoconfig.ts
//
// #348 (part of #332): orchestrator for cmux socket auto-config. Ties together
// the comment-preserving config write, the non-cmux probe, and a SEMI-AUTOMATIC,
// one-time restart prompt.
//
// See docs/specs/2026-06-16-cmux-socket-auth-daemon-direct-design.md §4.3–§4.4.
//
// This module decides WHAT to surface (configChanged / verdict / one-time
// prompt); it does not print or log. The caller — the `cockpit cmux autoconfig`
// CLI or the daemon-start re-check — renders the result. cockpit NEVER restarts
// cmux for the user (that disrupts live sessions); we write config and prompt.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureSocketAutomation } from "./cmux-config.js";
import { probeCmuxDaemonDirect, type ProbeVerdict } from "./cmux-probe.js";

/** One-time prompt marker, alongside the daemon state. */
export function defaultStatePath(): string {
  return join(homedir(), ".config", "cockpit", "state", "cmux-autoconfig.json");
}

export interface AutoConfigResult {
  /** Path of the cmux config inspected/written. */
  configPath: string;
  /** True when the cmux config was written this run. */
  configChanged: boolean;
  /** True when socketControlMode was already "automation". */
  configAlreadySet: boolean;
  /** Live socket reachability from a non-cmux process. */
  verdict: ProbeVerdict;
  /** Config is in place but the live socket still rejects (cmux restart needed). */
  needsRestart: boolean;
  /** The one-time restart prompt fired this run (false on repeats — no nag). */
  promptedThisRun: boolean;
}

export interface AutoConfigOpts {
  configPath?: string;
  statePath?: string;
  /** Injectable for tests. Default = ensureSocketAutomation. */
  ensureConfig?: typeof ensureSocketAutomation;
  /** Injectable for tests. Default = the real orphan probe. */
  probe?: () => Promise<ProbeVerdict>;
}

interface PromptState {
  promptedRestart?: boolean;
}

function readState(path: string): PromptState {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PromptState;
  } catch {
    return {};
  }
}

/**
 * Idempotent: write the cmux automation config (if needed), probe the live
 * socket, and fire a one-time restart prompt when the socket still rejects.
 *
 * Safe to call on every daemon start — it recovers the "cmux not running at
 * first write" edge case (§3.4): the value is already file-managed, so the next
 * start re-probes and daemon-direct activates once cmux is (re)launched.
 */
export async function ensureCmuxAutoConfig(opts: AutoConfigOpts = {}): Promise<AutoConfigResult> {
  const statePath = opts.statePath ?? defaultStatePath();
  const ensureConfig = opts.ensureConfig ?? ensureSocketAutomation;
  const probe = opts.probe ?? probeCmuxDaemonDirect;

  const cfg = ensureConfig({ path: opts.configPath });
  const verdict = await probe();
  const needsRestart = verdict === "denied";

  let promptedThisRun = false;
  if (needsRestart) {
    const already = readState(statePath).promptedRestart === true;
    if (!already) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ promptedRestart: true }));
      promptedThisRun = true;
    }
  } else if (verdict === "reachable") {
    // Reset the marker so a future regression (e.g. cmux config wiped) re-prompts.
    if (existsSync(statePath)) rmSync(statePath, { force: true });
  }

  return {
    configPath: cfg.path,
    configChanged: cfg.changed,
    configAlreadySet: cfg.alreadySet,
    verdict,
    needsRestart,
    promptedThisRun,
  };
}
