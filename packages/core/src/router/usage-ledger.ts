// packages/core/src/router/usage-ledger.ts
// U5: in-memory, per-project accumulation of routed usage/cost. The router shim's
// token is minted per project (U1), so the shim can only attribute usage to a
// project — per-crew attribution would require per-crew tokens (deferred). We
// accumulate per project and group by the request's model id, which is captured
// per request from the request body.
import type { RouterUsage } from "./types.js";

export interface ModelUsage {
  requests: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProjectUsage {
  project: string;
  requests: number;
  costUsd: number;
  /** Keyed by model id; requests without a model land under "unknown". */
  models: Record<string, ModelUsage>;
}

export interface RouterUsageLedger {
  record(u: RouterUsage): void;
  project(project: string): ProjectUsage | undefined;
  snapshot(): ProjectUsage[];
}

export function createUsageLedger(): RouterUsageLedger {
  const byProject = new Map<string, ProjectUsage>();
  return {
    record(u) {
      const p = byProject.get(u.project) ?? { project: u.project, requests: 0, costUsd: 0, models: {} };
      const model = u.model ?? "unknown";
      const m = p.models[model] ?? { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      p.requests += 1;
      p.costUsd += u.costUsd ?? 0;
      m.requests += 1;
      m.costUsd += u.costUsd ?? 0;
      m.inputTokens += u.inputTokens ?? 0;
      m.outputTokens += u.outputTokens ?? 0;
      p.models[model] = m;
      byProject.set(u.project, p);
    },
    project(project) {
      return byProject.get(project);
    },
    snapshot() {
      return [...byProject.values()];
    },
  };
}
