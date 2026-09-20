// packages/core/src/captain-router.ts
// #772 follow-up: router-backed CAPTAIN launches. A captain has no backend
// selection today (launch has no --backend, launch-workspace has no router
// handling), so a claude captain on the router fell through to Claude Code's
// built-in auto-mode classifier — which is hardcoded to Claude Sonnet 5 and
// fails CLOSED ("bash denied by auto mode · Classifier unavailable"). This
// resolves a captain's backend exactly like a crew spawn and, when routed,
// switches the session onto the U7 permission gate:
//   - permission mode → "default" (so PermissionRequest fires and the gate
//     intercepts, instead of `auto` making the gate yield);
//   - SQUADRANT_GATE=on in the session env (the gate owns the event);
//   - the router env in a per-spawn --settings file (#822's writeRouterSettings)
//     so defaults.claudeEnv cannot shadow the shim.
// Native is byte-for-byte unchanged. I/O is injected so the CLI edge wires the
// daemon credentials fetch + settings writer, and a routed launch FAILS LOUD
// when either is missing rather than silently bypassing the router.
//
// Design: docs/specs/2026-09-20-router-permission-gate-u7-design.md

import { resolveRouterModel, type BackendMode, type SquadrantConfig } from "@squadrant/shared";
import { assertBackendUsable, claudeEnvShadowsRouter } from "./router-resolution.js";
import { buildRouterEnv } from "./router/env.js";
import type { RouterCredentials } from "./router/service.js";

export interface CaptainRouterDeps {
  /** CLI-edge: daemon-resolved router credentials (shim URL + minted token, or
   *  the direct upstream key). Required for a routed captain launch. */
  routerCredentials?: (o: { project: string; backend: "direct" | "proxy" }) => Promise<RouterCredentials>;
  /** CLI-edge: #822's per-spawn `--settings` writer. Required for a routed
   *  captain launch so the router env outranks defaults.claudeEnv. */
  writeRouterSettings?: (o: { stateRoot: string; project: string; taskId: string; env: Record<string, string> }) => string;
}

export interface CaptainRouteSetup {
  backend: BackendMode;
  /** The model the launch should use: router-expanded when routed, the raw
   *  configured/overridden value when native. */
  model: string | undefined;
  /** Claude `--permission-mode`. `default` for routed, operator config native. */
  permissionMode: string;
  /** Process-env assignments the captain command must carry: the router env plus
   *  the gate marker. `{}` for native (command line byte-for-byte unchanged). */
  env: Record<string, string>;
  /** Present only when routed: the per-spawn `--settings` file path. */
  settingsPath?: string;
}

/**
 * Decide how a captain launch should run for the resolved backend. Pure apart
 * from the injected credentials fetch + settings write; never mutates config.
 */
export async function prepareCaptainRoute(o: {
  backend: BackendMode;
  agentName: string;
  configuredPermissionMode: string;
  project: string;
  model?: string;
  stateRoot: string;
  config: SquadrantConfig;
  deps: CaptainRouterDeps;
  warn?: (m: string) => void;
}): Promise<CaptainRouteSetup> {
  assertBackendUsable({ backend: o.backend, agent: o.agentName, router: o.config.defaults.router });

  if (o.backend === "native") {
    return { backend: "native", model: o.model, permissionMode: o.configuredPermissionMode, env: {} };
  }

  if (!o.deps.routerCredentials) {
    throw new Error(
      `captain launch: backend '${o.backend}' requires router credentials from the daemon, but this launch path has no credentials provider`,
    );
  }
  if (!o.deps.writeRouterSettings) {
    throw new Error(
      `captain launch: backend '${o.backend}' requires a per-spawn --settings writer to outrank defaults.claudeEnv, but this launch path has none — refusing to launch a routed captain that would silently bypass the router shim`,
    );
  }

  const model = resolveRouterModel(o.model, o.agentName, o.config.defaults.router);
  const creds = await o.deps.routerCredentials({ project: o.project, backend: o.backend });
  const routerEnv = buildRouterEnv(creds, model);

  const shadowed = claudeEnvShadowsRouter(o.config.defaults.claudeEnv);
  if (shadowed.length > 0) {
    o.warn?.(
      `backend '${o.backend}' selected but defaults.claudeEnv sets ${shadowed.join(", ")} — these would shadow the router shim. Overriding via a per-spawn --settings env block (outranks ~/.claude/settings.json).`,
    );
  }

  const settingsPath = o.deps.writeRouterSettings({
    stateRoot: o.stateRoot,
    project: o.project,
    taskId: "captain",
    env: routerEnv,
  });

  return {
    backend: o.backend,
    model,
    permissionMode: "default",
    env: { ...routerEnv, SQUADRANT_GATE: "on" },
    settingsPath,
  };
}
