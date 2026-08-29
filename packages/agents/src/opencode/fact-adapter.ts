/**
 * Opencode SSE frame → AgentFact. Replaces OpencodeControlSource, which read
 * already-translated ControlEvents and translated them back (spec §1, problem 2).
 *
 * Frame shapes verified live against opencode 1.15.13 — see sse-bridge.ts:198.
 */
import type { FactAdapter, RawFact } from "@squadrant/core";

export interface OpencodeFactAdapterDeps {
  /** The bridge's existing counter. Ids must not be regenerated downstream. */
  nextRequestId: () => number;
}

interface Frame {
  type?: unknown;
  properties?: {
    sessionID?: unknown;
    id?: unknown;
    permission?: unknown;
    patterns?: unknown;
  };
}

export function createOpencodeFactAdapter(deps: OpencodeFactAdapterDeps): FactAdapter {
  return {
    name: "opencode-sse",
    origin: "agent",

    translate(raw: unknown): RawFact[] {
      const f = (typeof raw === "object" && raw !== null ? raw : {}) as Frame;
      const type = typeof f.type === "string" ? f.type : undefined;
      if (type === undefined) return [{ kind: "unknown", name: "non-object" }];

      const p = f.properties ?? {};

      if (type === "session.idle") {
        return [{
          kind: "turn.ended",
          turnId: typeof p.sessionID === "string" ? p.sessionID : undefined,
        }];
      }

      if (type === "permission.asked") {
        // The bridge requires both ids to POST an answer later; without them
        // this frame is unusable — record it rather than drop it.
        if (typeof p.id !== "string" || typeof p.sessionID !== "string") {
          return [{ kind: "unknown", name: "permission.asked:incomplete" }];
        }
        const tool = typeof p.permission === "string" ? p.permission : "a tool";
        const cmd = Array.isArray(p.patterns) && p.patterns.length
          ? `: ${p.patterns.join(" ")}`
          : "";
        return [{
          kind: "permission.requested",
          question: `opencode requests permission to run ${tool}${cmd}`,
          requestId: deps.nextRequestId(),
          tool,
        }];
      }

      if (type === "permission.replied") return [{ kind: "activity" }];

      return [{ kind: "unknown", name: type }];
    },
  };
}
