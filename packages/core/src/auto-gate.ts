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
  resolveApiKey,
  type AutoGateConfig,
  type BlockedSignalCtx,
  type GateOutcome,
  type SquadrantGateShape,
} from "@squadrant-ai/auto-gate";
import type { ControlEvent, SquadrantConfig } from "@squadrant/shared";
import { readUserIntent, resolveGateEngine, resolveGateMode } from "./permission-gate.js";

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
 * Whether the auto-gate engine's credential resolves — env `TYPESAFE_API_KEY`
 * first, then the package's `~/.auto-gate-key` file fallback (§12). Delegates
 * to the package's own `resolveApiKey` so the two can never disagree about
 * where the credential comes from; the resolved value itself is discarded
 * here — only presence is reported (#854). `home` is test-only (defaults to
 * the real homedir via the package).
 */
export function hasAutoGateCredential(env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  return Boolean(resolveApiKey({ env, ...(home !== undefined ? { home } : {}) }));
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

  // Resolve the mode the U7 way (env SQUADRANT_GATE → config → auto) and feed
  // the package a projection whose mode reflects it. `projectGateConfig` maps
  // an absent/auto config mode to "off", so a router session (SQUADRANT_GATE=on
  // with no config gate block) would otherwise be a silent no-op (P6-C).
  const mode = resolveGateMode(env, deps.config.defaults.gate);
  const projected = projectGateConfig({ gate: { ...gateForProjection(deps.config), mode } });
  const enabled = mode === "on";
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

// ── opencode launch wiring (P6-C phase 2, #828) ────────────────────────────────
//
// opencode has no PermissionRequest hook — the package answers its permission
// prompts by wrapping the whole process (buildRunPlan + supervise from
// @squadrant-ai/auto-gate, exported from the package root). That pair is async
// and only runs INSIDE the pane (via the `squadrant gate opencode-run` CLI-edge
// command — packages/cli/src/commands/gate-opencode-run.ts), so the decision of
// WHETHER to route through it is made here, synchronously, at command-build
// time in crew-spawn.ts / launch.ts — before any pane exists.

export interface OpencodeGateDecision {
  /** True ⇒ launch through the auto-gate opencode adapter. */
  wrap: boolean;
  /** True ⇒ the gate was requested (mode=on, engine=auto-gate) but can't be
   *  honored right now — the caller should log exactly one warning and fall
   *  back to launching opencode directly (a gate problem must never stop a
   *  crew from starting). */
  warn: boolean;
  reason: string;
}

/**
 * Pure/sync: whether an opencode crew/captain launch should route through the
 * auto-gate opencode adapter instead of a bare `opencode …` command. `hasCredential`
 * is injectable so callers (and tests) never depend on the real ~/.auto-gate-key
 * file; defaults to the real `hasAutoGateCredential`.
 */
export function decideOpencodeGateWrap(o: {
  config: SquadrantConfig;
  env?: NodeJS.ProcessEnv;
  hasCredential?: (env: NodeJS.ProcessEnv) => boolean;
}): OpencodeGateDecision {
  const env = o.env ?? process.env;
  const gate = o.config.defaults.gate;
  const mode = resolveGateMode(env, gate);
  const engine = resolveGateEngine(env, gate);
  if (mode !== "on" || engine !== "auto-gate") {
    return { wrap: false, warn: false, reason: `gate mode='${mode}' engine='${engine}'` };
  }
  const hasCredential = o.hasCredential ?? hasAutoGateCredential;
  if (!hasCredential(env)) {
    return {
      wrap: false,
      warn: true,
      reason: "auto-gate credential not present (TYPESAFE_API_KEY / ~/.auto-gate-key)",
    };
  }
  return { wrap: true, warn: false, reason: "gate on, engine=auto-gate, credential present" };
}

/**
 * The command a gate-wrapped opencode crew/captain pane runs instead of a bare
 * `opencode …`. `port` MUST be the same port squadrant already allocated for
 * its own SSE bridge (turn-end detection, CREW DONE, approval answering) —
 * `squadrant gate opencode-run` hands it to `buildRunPlan`'s `allocate`, which
 * is the package's documented host-injection point (README "opencode"), so
 * opencode binds the one port everything else already expects.
 */
export function buildOpencodeGateRunCommand(o: { port: number; sessionId?: string }): string {
  let cmd = `squadrant gate opencode-run --port ${o.port}`;
  if (o.sessionId) cmd += ` --session ${o.sessionId}`;
  return cmd;
}
