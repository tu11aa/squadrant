// packages/core/src/auto-gate.ts
// P6 (#828): squadrant consumes the standalone @squadrant-ai/auto-gate package
// through its §3 bridge. This module owns the three squadrant-side seams:
//   1. config   — project `defaults.gate` with projectGateConfig;
//   2. userIntent — supply U7's transcript reader (readUserIntent, which wraps
//                   extractUserIntentFromTranscript);
//   3. blocked  — map the package's injected blocked signal onto the existing
//                 #560 `task.blocked` event so an unattended `ask` reaches the
//                 captain/Telegram.
//
// Additive by design: the U7 `squadrant gate claude permission-request` path is
// unchanged. `auto` is squadrant's documented no-op (shared/config.ts), so only
// an explicit `mode: "on"` runs the package gate — `projectGateConfig` maps
// `auto`/absent to the package's `off`.
//
// Design: docs/specs/2026-09-20-provider-agnostic-auto-gate-design.md §3/§10/§12.

import {
  createAutoGate,
  projectGateConfig,
  type AutoGateConfig,
  type BlockedSignalCtx,
  type GateOutcome,
  type SquadrantGateShape,
} from "@squadrant-ai/auto-gate";
import type { ControlEvent, SquadrantConfig } from "@squadrant/shared";
import { readUserIntent } from "./permission-gate.js";

export interface SquadrantAutoGateDeps {
  config: SquadrantConfig;
  env?: NodeJS.ProcessEnv;
  /** Project for the blocked event (default: SQUADRANT_CREW_PROJECT). */
  project?: string;
  /** Emits the #560 task.blocked event on the ask path (daemon socket). */
  sendBlocked?: (project: string, event: ControlEvent) => Promise<void>;
  /** Injectable for tests; defaults to the package's P3 runtime. */
  decide?: (req: unknown) => Promise<GateOutcome>;
  log?: (m: string) => void;
}

export interface SquadrantAutoGate {
  /** The resolved, merged auto-gate config squadrant handed the package. */
  config: AutoGateConfig;
  /** The claude `PermissionRequest` hook handler (§3 interface 2+3). */
  decideClaudeHookPayload(raw: string): Promise<string | undefined>;
}

/**
 * Project squadrant's U7 `defaults.gate` onto the package's portable config
 * shape. U7's `policy` is a string enum (`deny-dangerous`/`ask-on-doubt`) with
 * no package equivalent (the package resolves named presets `strict` /
 * `balanced` / `permissive`), so it is deliberately not forwarded — the package
 * default applies. `mode` is the projection's load-bearing field.
 */
function gateForProjection(config: SquadrantConfig): SquadrantGateShape {
  const gate = config.defaults.gate;
  if (!gate) return {};
  const out: SquadrantGateShape = {};
  if (gate.mode) out.mode = gate.mode;
  if (gate.tools) out.tools = gate.tools;
  if (gate.deny) out.deny = gate.deny;
  return out;
}

/**
 * Build the squadrant-owned auto-gate host. When `defaults.gate.mode` is not
 * `"on"` (`"auto"` or absent) the returned handler is a NO-OP: it emits nothing
 * and never decides — the agent's normal permission flow owns the prompt.
 */
export function createSquadrantAutoGate(deps: SquadrantAutoGateDeps): SquadrantAutoGate {
  const env = deps.env ?? process.env;
  const taskId = env.SQUADRANT_CREW_TASK_ID;
  const project = deps.project ?? env.SQUADRANT_CREW_PROJECT;

  const projected = projectGateConfig({ gate: gateForProjection(deps.config) });
  const enabled = projected.mode === "on";

  const blockedSignal = async (ctx: BlockedSignalCtx): Promise<void> => {
    // Same event shape the modal/PermissionRequest path emits (#560/#760); a
    // captain/side session has no task record, so it never emits.
    if (!taskId || !project || !deps.sendBlocked) return;
    const event: ControlEvent = {
      type: "task.blocked",
      id: taskId,
      reason: ctx.reason,
      question: `crew needs permission to run ${ctx.tool}`,
    };
    await deps.sendBlocked(project, event);
  };

  const host = createAutoGate({
    config: projected,
    readIntent: (p) => readUserIntent(p) ?? undefined,
    blockedSignal,
    ...(deps.decide ? { decide: deps.decide } : {}),
    ...(project ? { project } : {}),
    env,
    log: deps.log,
  });

  if (!enabled) {
    // `auto`/absent ⇒ documented no-op (spec §10/§12). Never decide, never signal.
    return { config: host.config, decideClaudeHookPayload: async () => undefined };
  }
  return host;
}
