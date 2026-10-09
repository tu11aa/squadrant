// #917: deliver a claude crew's first turn over the claude peer channel, gated on
// the session registry's own `idle` self-report instead of screen-scraping.
//
// Pure orchestration over injected deps (core cannot import @squadrant/agents or
// any runtime). Three outcomes, chosen so the caller never double-delivers:
//   delivered   — a turn was observed (confirmed accept, or the hook receipt)
//   fallback    — nothing was sent (not ready in time / socket gone); the caller
//                 uses the existing pane path unchanged
//   unconfirmed — bytes were accepted but no receipt arrived; the caller must NOT
//                 paste again (claude would run the brief twice)

import { fallsBackToPane, type DeliveryOutcome } from "./control-channel.js";

export interface PeerFirstTurnDeps {
  /** Registry status for this crew's socket; undefined ⇒ no registry entry yet
   *  (booting, or the folder-trust panel is open). */
  statusOf(): { status?: string } | undefined;
  readScreen(): Promise<string>;
  /** Accept the folder-trust panel (default option is "Yes, proceed"). */
  answerTrust(): Promise<void>;
  send(message: string): Promise<DeliveryOutcome>;
  /** Has the daemon stamped firstTurnConfirmedAt (UserPromptSubmit receipt)? */
  isConfirmed(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  readyTimeoutMs?: number;
  pollMs?: number;
  confirmGraceMs?: number;
}

export type PeerFirstTurnResult = { kind: "delivered" } | { kind: "fallback" } | { kind: "unconfirmed" };

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_CONFIRM_GRACE_MS = 10_000;
/** Don't re-press Enter on a trust panel that is still repainting. */
const TRUST_ANSWER_COOLDOWN_MS = 2_000;

/** The folder-trust panel: no registry entry exists while it is open. */
export function screenShowsTrustPanel(screen: string): boolean {
  return /do you trust the files in this folder|is this a project you (created or )?trust/i.test(screen);
}

export async function deliverFirstTurnViaPeer(message: string, deps: PeerFirstTurnDeps): Promise<PeerFirstTurnResult> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = deps.now() + (deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let lastTrustAnswer = -Infinity;

  for (;;) {
    if (deps.statusOf()?.status === "idle") break;
    if (deps.now() >= deadline) return { kind: "fallback" };
    if (!deps.statusOf() && deps.now() - lastTrustAnswer >= TRUST_ANSWER_COOLDOWN_MS) {
      const screen = await deps.readScreen().catch(() => "");
      if (screenShowsTrustPanel(screen)) {
        lastTrustAnswer = deps.now();
        await deps.answerTrust().catch(() => {});
      }
    }
    await deps.sleep(pollMs);
  }

  const outcome = await deps.send(message);
  if (fallsBackToPane(outcome)) return { kind: "fallback" };
  if (outcome.status === "accepted" && outcome.confirmed) return { kind: "delivered" };

  // Accepted/queued/held without an observed turn: wait for the hook receipt.
  const confirmDeadline = deps.now() + (deps.confirmGraceMs ?? DEFAULT_CONFIRM_GRACE_MS);
  for (;;) {
    if (await deps.isConfirmed().catch(() => false)) return { kind: "delivered" };
    if (deps.now() >= confirmDeadline) return { kind: "unconfirmed" };
    await deps.sleep(pollMs);
  }
}
