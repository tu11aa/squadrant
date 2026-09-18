// packages/core/src/router/credentials.ts
// U3: the CLI↔daemon verb a routed spawn uses to obtain the shim URL + minted
// token. The shim is daemon-internal (U2 decision 1), so the spawn path cannot
// derive these locally. Additive protocol kind — both sides ship together, so
// PROTOCOL_VERSION is not bumped (an older running daemon simply errors, which
// the spawn surfaces as a hard failure rather than a silent unauth'd launch).
import type { RouterCredentials, RouterService } from "./service.js";

export type RouterBackend = "direct" | "proxy";

export interface RouterCredentialsRequest {
  kind: "router-credentials";
  project: string;
  backend: RouterBackend;
}

export function buildRouterCredentialsRequest(
  project: string,
  backend: RouterBackend,
): RouterCredentialsRequest {
  return { kind: "router-credentials", project, backend };
}

/** Bounded readiness wait: 10 × 200 ms = 2 s (well inside the CLI's 5 s socket
 *  timeout). `service.start()` is fire-and-forget at daemon boot, so
 *  `credentialsFor("proxy")` throws "router service not started" until it
 *  resolves (U2 plan Task 4.2 note: "U3 owns waiting on health()"). */
export const ROUTER_READY_ATTEMPTS = 10;
export const ROUTER_READY_DELAY_MS = 200;

export async function resolveRouterCredentials(
  service: RouterService,
  project: string,
  backend: RouterBackend,
  deps: { sleep?: (ms: number) => Promise<void>; attempts?: number; delayMs?: number } = {},
): Promise<RouterCredentials> {
  if (backend === "proxy") {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempts = deps.attempts ?? ROUTER_READY_ATTEMPTS;
    const delayMs = deps.delayMs ?? ROUTER_READY_DELAY_MS;
    for (let i = 0; i < attempts; i++) {
      const health = await service.health();
      if (health.ready) break;
      await sleep(delayMs);
    }
  }
  return service.credentialsFor(project, backend);
}
