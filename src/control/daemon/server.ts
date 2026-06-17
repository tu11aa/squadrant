// src/control/daemon/server.ts
// IPC socket server: message router + attach fan-in.
// All state lives on DaemonContext; callbacks that can't yet be on ctx are
// passed via ServerHandlers (built once in cockpitd.ts/start.ts).
import { startServer, encodeFrame } from "../protocol.js";
import { TERMINAL_STATES } from "@cockpit/shared";
import type { AttachFrame, AttachInbound } from "../protocol.js";
import type { ComponentHealth } from "../liveness.js";
import type { DaemonSnapshotInputs } from "../snapshot.js";
import type { DaemonContext } from "./context.js";

export interface ServerHandlers {
  /** Build per-component health list (optionally filtered to one project). */
  buildHealth: (project?: string) => ComponentHealth[];
  /** Gather full snapshot inputs (all I/O). */
  gatherSnapshotInputs: (now: number) => Promise<DaemonSnapshotInputs>;
  /** Cancel pending gate-promotion timers when a client attaches. */
  cancelPromotionsFor: (taskId: string) => void;
  /** Fan-out an AttachFrame to all clients watching a task. */
  broadcast: (taskId: string, f: AttachFrame) => void;
}

export function createServer(
  ctx: DaemonContext,
  handlers: ServerHandlers,
) {
  const { store, log, pendingProbes, inFlightProbes, probeResults, attachConns } = ctx;
  const { buildHealth, gatherSnapshotInputs, cancelPromotionsFor, broadcast } = handlers;

  return startServer(ctx.sockPath, {
    handler: async (msg: any) => {
      if (msg.kind === "seed") { store.put(msg.record); return { ok: true }; }
      // Crew-close teardown for codex: the cmux pane only hosts the `crew attach`
      // renderer — the thread lives on the shared app-server, so closing the pane
      // doesn't reap it. `cockpit crew close` calls this to archive the thread and
      // its per-thread MCP servers (else they leak ~53MB/crew). Fires for terminal
      // and non-terminal crews alike.
      if (msg.kind === "codex-close") {
        await ctx.codexDriver.close(msg.taskId).catch((e: unknown) => log(`codex close err: ${e}`));
        return { ok: true };
      }
      // #207 relay registration: the notify-relay announces itself on boot and
      // heartbeats every ~10s so the daemon can health-check it on the sweep.
      if (msg.kind === "relay-register") {
        ctx.d.registerRelay({ project: msg.project, pid: msg.pid, startedAt: msg.startedAt ?? Date.now() });
        return { ok: true };
      }
      if (msg.kind === "relay-heartbeat") {
        ctx.d.relayHeartbeat({ project: msg.project, pid: msg.pid });
        return { ok: true };
      }
      // #239 Phase B: relay proxy — crew-surface liveness probes.
      // The relay polls for pending probes, executes them in-lineage (cmux-accessible),
      // and posts results back. Handled inline so they never reach d.handle()'s
      // unknown-kind guard.
      if (msg.kind === "relay-proxy-poll") {
        const project = msg.project as string;
        const probes = pendingProbes.get(project) ?? [];
        pendingProbes.set(project, []); // clear after handing off to the relay
        for (const p of probes) inFlightProbes.add(p.taskId); // mark in-flight
        return probes;
      }
      if (msg.kind === "relay-proxy-result") {
        const results = msg.results as Array<{ taskId: string; liveness: "alive" | "gone" | "unknown" }>;
        for (const r of results) {
          probeResults.set(r.taskId, r.liveness);
          inFlightProbes.delete(r.taskId); // result received — no longer in-flight
        }
        return { ok: true };
      }
      // #77 service-health surface: per-component liveness for the queried project (or all).
      if (msg.kind === "health") {
        return buildHealth(msg.project as string | undefined);
      }
      // #44 dashboard: read-only full system snapshot (Tier 0/1/2).
      if (msg.kind === "snapshot") {
        const now = Date.now();
        const { assembleDaemonSnapshot } = await import("../snapshot.js");
        return assembleDaemonSnapshot(await gatherSnapshotInputs(now), now);
      }
      // #239 Phase B: on any event that terminates a task, evict its entries from
      // inFlightProbes and probeResults so the Sets never leak.
      if (msg.kind === "event") {
        const rec = await ctx.d.handle(msg);
        if (TERMINAL_STATES.has((rec as any).state)) {
          inFlightProbes.delete((rec as any).id);
          probeResults.delete((rec as any).id);
        }
        return rec;
      }
      return ctx.d.handle(msg);
    },
    onAttach: (conn, frame) => {
      let set = attachConns.get(frame.taskId);
      if (!set) { set = new Set(); attachConns.set(frame.taskId, set); }
      set.add(conn);
      // A client arriving within the 5s window defuses any pending gate timer.
      cancelPromotionsFor(frame.taskId);
      // Immediately ack the attach so the client knows it's live.
      try { conn.write(encodeFrame({ type: "reattached", taskId: frame.taskId })); } catch { /* ignore */ }
    },
    onAttachInbound: (_conn, frame) => {
      const f = frame as AttachInbound;
      if (f.op === "say")
        void ctx.codexDriver.say(f.taskId, f.text).catch((e: unknown) => log(`say err: ${e}`));
      else if (f.op === "steer")
        void ctx.codexDriver.steer(f.taskId, f.text).catch((e: unknown) => log(`steer err: ${e}`));
      else if (f.op === "interrupt")
        void ctx.codexDriver.interrupt(f.taskId).catch((e: unknown) => log(`interrupt err: ${e}`));
      else if (f.op === "answer")
        void ctx.codexDriver.answer(f.taskId, f.payload).catch((e: unknown) => log(`answer err: ${e}`));
    },
    onAttachClose: (conn) => {
      for (const set of attachConns.values()) set.delete(conn);
    },
  });
}
