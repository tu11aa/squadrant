// src/control/daemon/gates.ts
// resolveInteractiveGate: route the captain's approve/deny to the owning driver.
// Reads ctx.codexDriver and ctx.opencodeBridge lazily (set by cockpitd.ts before
// any gate message can arrive on the socket).
import type { DaemonContext } from "./context.js";

export function createGateResolver(ctx: DaemonContext) {
  return async (taskId: string, payload: unknown): Promise<void> => {
    const rec = ctx.store.listAll().find((r) => r.id === taskId);
    try {
      if (rec?.provider === "opencode") {
        // Only an explicit "approve" approves; any other reply denies —
        // never auto-approve a permission gate.
        const decision = (payload as { decision?: string })?.decision === "approve" ? "approve" : "deny";
        await ctx.opencodeBridge.answer(taskId, decision);
      } else {
        await ctx.codexDriver.answer(taskId, payload);
      }
    } catch (e) { ctx.log(`gate-resolve answer failed: ${(e as Error).message}`); }
  };
}
