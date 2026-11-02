// #1096: captain → side session / thread delivery.
//
// A claude side session or thread is launched with a socket path squadrant
// chose (like the captain's), so a message reaches it over the Claude peer
// channel as a <cross-session-message>, not as a pasted user turn. When there
// is no live socket (opencode/codex, or a claude that has exited) the message
// goes through the confirmed-submit pane chokepoint (#1087). Never a silent
// paste: a failed fallback throws.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PaneRef } from "@squadrant/shared";
import { CC_SOCKS_DIR, ensureSocksDir } from "./crew-spawn.js";
import { describeOutcome, fallsBackToPane, type ControlChannel, type DeliveryOutcome } from "./control-channel.js";

// A hash, not the names: project and side/thread names are free text, and a
// unix socket path is capped near 104 bytes on macOS.
function socketPathFor(kind: "side" | "thread", project: string, id: string, dir: string): string {
  const h = createHash("sha1").update(`${project}\0${id}`).digest("hex").slice(0, 16);
  return `${dir}/squadrant-${kind}-${h}.sock`;
}

export const sideSocketPath = (project: string, name: string, dir: string = CC_SOCKS_DIR): string =>
  socketPathFor("side", project, name, dir);

export const threadSocketPath = (project: string, id: string, dir: string = CC_SOCKS_DIR): string =>
  socketPathFor("thread", project, id, dir);

/** Before launching into `socketPath`: private dir (claude refuses otherwise) and no stale socket from a dead session. */
export function prepareSessionSocket(socketPath: string): void {
  ensureSocksDir(socketPath.slice(0, socketPath.lastIndexOf("/")));
  fs.rmSync(socketPath, { force: true });
}

const PINNED_MARKER = "socket";

/** Side sessions: record next to init.md that a socket was pinned at launch. */
export function markSidePinned(sideDir: string, socketPath: string): void {
  fs.mkdirSync(sideDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sideDir, PINNED_MARKER), socketPath, { mode: 0o600 });
}

export const isSidePinned = (sideDir: string): boolean => fs.existsSync(path.join(sideDir, PINNED_MARKER));

export interface SessionDeliveryDeps {
  /** Claude peer channel keyed by socket path. Absent ⇒ pane only. */
  channel?: ControlChannel;
  /** The #1087 confirmed-submit chokepoint. */
  sendToPane: (pane: PaneRef, text: string) => Promise<{ delivered: boolean; blockedByModal?: boolean; reason?: "no-agent" }>;
  log?: (m: string) => void;
}

export interface SessionDelivery {
  via: "peer" | "pane";
  /** One-line description for the CLI success line. */
  detail: string;
}

function peerDetail(o: DeliveryOutcome): string {
  switch (o.status) {
    case "accepted": return o.confirmed === false ? "peer channel, accepted, no turn observed yet" : "peer channel, accepted";
    case "queued": return "peer channel, queued behind the running turn";
    case "held": return `peer channel, held: ${o.reason}`;
    default: return "peer channel";
  }
}

/**
 * `pinned`: a socket was pinned when this session launched (recorded at spawn).
 * A pinned session is only ever reached over its socket: when claude exits it
 * removes the socket and the pane is a bare shell, so a pane paste would run the
 * message as shell commands. Only unpinned sessions (non-claude, or launched
 * before #1096) use the pane.
 */
export async function deliverToSession(
  pane: PaneRef,
  socketPath: string,
  pinned: boolean,
  text: string,
  deps: SessionDeliveryDeps,
): Promise<SessionDelivery> {
  if (pinned) {
    if (!deps.channel) throw new Error("not delivered: the peer channel is unavailable (receipt listener could not start); the session was not touched.");
    const outcome: DeliveryOutcome = await deps.channel.send(socketPath, text);
    deps.log?.(`session-delivery ${pane.surfaceId}: ${fallsBackToPane(outcome) ? outcome.status : describeOutcome(outcome)}`);
    // accepted / queued / held all reached the session (or a human gate in front of it).
    if (!fallsBackToPane(outcome)) return { via: "peer", detail: peerDetail(outcome) };
    throw new Error("not delivered: the session is no longer running (its claude exited, or the message was denied or expired). Relaunch it (`thread resume`, or `side spawn`).");
  }
  const r = await deps.sendToPane(pane, text);
  if (r.delivered) return { via: "pane", detail: "pane, submit confirmed" };
  if (r.reason === "no-agent") throw new Error("not delivered: the agent in that pane is not running (nothing was typed).");
  throw new Error(
    r.blockedByModal
      ? "not delivered: an open dialog in the session's pane is waiting for an answer."
      : "not delivered: the session's pane has a draft in its input box, or the submit was not confirmed.",
  );
}
