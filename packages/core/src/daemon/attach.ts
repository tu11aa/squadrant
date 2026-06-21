// src/control/daemon/attach.ts
// Attach fan-out and gate-promotion logic (spec §4.5/§4.6/§4.9).
import { randomUUID } from "node:crypto";
import { encodeFrame } from "../protocol.js";
import { makeGate } from "../gate.js";
import type { AttachFrame } from "../protocol.js";
import type { Gate } from "@squadrant/shared";
import type { DaemonContext } from "./context.js";

export interface AttachHandlers {
  broadcast: (taskId: string, f: AttachFrame) => void;
  schedulePromotion: (taskId: string, requestId: number, kind: "input" | "approval", question: string) => void;
  cancelPromotionsFor: (taskId: string) => void;
}

/** Build the attach fan-out and gate-promotion machinery. Call once in start.ts
 *  immediately after buildContext; assign the returned handlers onto ctx so the
 *  driver emit callbacks can reference them via the context object. */
export function createAttach(ctx: DaemonContext): AttachHandlers {
  const { attachConns, store, log } = ctx;

  function broadcast(taskId: string, f: AttachFrame): void {
    const conns = attachConns.get(taskId);
    if (!conns) return;
    const wire = encodeFrame(f);
    for (const conn of conns) {
      try { conn.write(wire); } catch { /* client gone; onAttachClose will clean up */ }
    }
  }

  // ── Gate promotion (spec §4.9) ─────────────────────────────────────────────
  // When a server-request event fires and no client is attached, start a 5s
  // timer. If still unattached at fire time, promote to a Gate in the store
  // and broadcast gate-promoted so any later-attaching client can offer takeover.
  const pendingGateTimers = new Map<string, { taskId: string; timer: NodeJS.Timeout }>();

  function schedulePromotion(
    taskId: string,
    requestId: number,
    kind: "input" | "approval",
    question: string,
  ): void {
    // If a client is already attached for this task, no promotion needed.
    const conns = attachConns.get(taskId);
    if (conns && conns.size > 0) return;
    const key = `${taskId}#${requestId}`;
    // Clear any prior timer for the same (taskId, requestId).
    const prior = pendingGateTimers.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      pendingGateTimers.delete(key);
      // Re-check at fire time — a client may have attached in the 5s window.
      if (attachConns.get(taskId)?.size) return;
      const rec = store.listAll().find((r) => r.id === taskId);
      if (!rec) return;
      const gate: Gate = makeGate({ taskId, kind, question, now: Date.now(), mkId: () => randomUUID() });
      const gates = [...(rec.gates ?? []), gate];
      store.put({ ...rec, gates });
      broadcast(taskId, { type: "gate-promoted", taskId, gateId: gate.gateId });
      log(`gate promoted gateId=${gate.gateId} taskId=${taskId} kind=${kind}`);
    }, 5_000);
    timer.unref?.();
    pendingGateTimers.set(key, { taskId, timer });
  }

  function cancelPromotionsFor(taskId: string): void {
    for (const [key, slot] of pendingGateTimers.entries()) {
      if (slot.taskId === taskId) {
        clearTimeout(slot.timer);
        pendingGateTimers.delete(key);
      }
    }
  }

  return { broadcast, schedulePromotion, cancelPromotionsFor };
}
