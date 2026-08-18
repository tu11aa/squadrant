// packages/core/src/captain-channel.ts
//
// #667 slice 4: deliver a captain-bound message over the control channel.
//
// Everything aimed at a captain — `squadrant ping`, a Telegram message, a
// sibling captain's dispatch — already funnels through the mailbox and the
// daemon's captain-delivery loop. So this one module upgrades all three.
//
// A captain is not a TaskRecord, so there is nothing to persist a socket path
// on. Slice 3 launches captains with a path derived from the project name; this
// recomputes the same string. The two formulas MUST stay identical — a test in
// each package asserts the exact string.
//
// SECURITY: the socket directory is a trust boundary (receipts are only sent
// within one namespace) and it is currently world-reachable. That hole is #675,
// is live today, and is NOT closed here. This module must not widen it: it only
// ever WRITES to a captain we launched, and never attests a from-mode.

import { join } from "node:path";
import type { ControlChannel, DeliveryOutcome, ControlChannelMode } from "./control-channel.js";
import { fallsBackToPane, describeOutcome } from "./control-channel.js";
// CC_SOCKS_DIR is defined by slice 3 (Task 7) — import it, do NOT redeclare it.
// Two definitions of this path would drift, and a drifted socket directory means
// receipts silently stop arriving (they are only delivered within one namespace).
import { CC_SOCKS_DIR } from "./crew-spawn.js";

export { CC_SOCKS_DIR };

/** Must match slice 3's captain launch site byte for byte. */
export function captainSocketPath(project: string, socksDir: string = CC_SOCKS_DIR): string {
  if (!/^[A-Za-z0-9._-]+$/.test(project)) {
    throw new Error(`captain-channel: project name '${project}' is not a safe socket filename`);
  }
  return join(socksDir, `squadrant-captain-${project}.sock`);
}

export interface CaptainChannelDeps {
  /** Injected — core may not import @squadrant/agents (one-way DAG). */
  channel?: ControlChannel;
  mode: ControlChannelMode;
  log?: (m: string) => void;
}

/**
 * Try the channel. `handled: true` means the caller must NOT touch the pane.
 *
 * accepted / queued / held all mean the message reached the captain (or reached
 * a human gate in front of it) — using the pane as well would double-send.
 * Only gone / unsupported fall through, and both are logged. A silent fallback
 * reintroduces exactly the ambiguity this port removes.
 */
export async function deliverToCaptain(
  project: string,
  text: string,
  deps: CaptainChannelDeps,
): Promise<{ handled: boolean; outcome?: DeliveryOutcome }> {
  if (deps.mode === "off") return { handled: false };
  if (!deps.channel) {
    deps.log?.(`captain-channel ${project}: no channel injected — falling back to pane`);
    return { handled: false };
  }

  if (deps.mode === "shadow") {
    // Non-mutating measurement only. NEVER send here — the pane is still
    // sending, and a channel send would deliver the message twice.
    const p = await deps.channel.probe(project);
    deps.log?.(`captain-channel ${project}: shadow probe — ${p.status}`);
    return { handled: false };
  }

  const outcome = await deps.channel.send(project, text);
  deps.log?.(`captain-channel ${project}: ${describeOutcome(outcome)}`);
  if (fallsBackToPane(outcome)) {
    deps.log?.(`captain-channel ${project}: falling back to pane`);
    return { handled: false, outcome };
  }
  return { handled: true, outcome };
}
