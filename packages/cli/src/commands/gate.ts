// gate.ts — `squadrant gate claude permission-request`
//
// The U7 (#782) hook handler. Claude Code's built-in auto-mode classifier is
// hardcoded to Claude Sonnet 5 and fails CLOSED on a router backend; this gate
// classifies with the operator's configured router model (no Anthropic
// credential) and steps aside when mode is off/auto.
//
// It is the SINGLE owner of the `PermissionRequest` event:
//   allow/deny → print `hookSpecificOutput.decision.behavior` and do NOT emit
//                task.blocked (the crew was never actually blocked);
//   ask/yield  → print nothing (normal dialog appears) and emit the existing
//                #560 task.blocked so the captain is still notified.
//
// Design: docs/specs/2026-09-20-router-permission-gate-u7-design.md

import { Command } from "commander";
import chalk from "chalk";
import { sendRequest } from "@squadrant/core";
import {
  GateDecisionCache,
  createSquadrantAutoGate,
  isGateSession,
  evaluatePermissionRequest,
  formatPermissionDecision,
  readUserIntent,
  resolveClassifierModel,
  resolveGateEngine,
  resolveGateMode,
  type DecisionCacheLike,
  type GateEvaluation,
  type SquadrantAutoGate,
  type SquadrantAutoGateDeps,
} from "@squadrant/core";
import {
  DAEMON_SOCK_PATH,
  DEFAULT_CONFIG_PATH,
  GATE_MODES,
  isGateMode,
  loadConfig,
  saveConfig,
  type GateMode,
  type SquadrantConfig,
} from "@squadrant/shared";
import type { ControlEvent } from "@squadrant/shared";
import { deriveTranscriptPath, mapClaudeHookToEvent } from "@squadrant/agents";

const SOCK = DAEMON_SOCK_PATH;

export interface GateHookDeps {
  payload: unknown;
  /** The RAW hook JSON string. The auto-gate engine parses it itself; U7 only
   *  needs the parsed object. Optional so existing callers/tests stay valid. */
  rawPayload?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: SquadrantConfig;
  cache?: DecisionCacheLike;
  fetchImpl?: typeof fetch;
  /** Writes the hook's permission decision (or nothing). */
  stdout?: (s: string) => void;
  /** Diagnostics — stderr, never stdout (Claude parses stdout JSON). */
  log?: (m: string) => void;
  /** Emits the #560 task.blocked event on the ask/yield path. */
  sendEvent?: (project: string, event: ControlEvent) => Promise<void>;
  loadConfigFn?: () => SquadrantConfig;
  readIntent?: (transcriptPath: string | undefined) => string | null;
  /** Injectable for tests; defaults to the squadrant auto-gate host (P6-C). */
  createAutoGate?: (deps: SquadrantAutoGateDeps) => SquadrantAutoGate;
}

/**
 * P6-C (#828): dispatch a claude `PermissionRequest` to the standalone
 * `@squadrant-ai/auto-gate` engine. The package owns the decision; we only
 * serialize its output and let it map an `ask` to the existing #560
 * `task.blocked` (via the injected blocked-signal).
 */
async function runAutoGateClaudeHook(o: {
  deps: GateHookDeps;
  env: NodeJS.ProcessEnv;
  config: SquadrantConfig;
  project: string | undefined;
  stdout: (s: string) => void;
  log: (m: string) => void;
}): Promise<GateEvaluation> {
  const make = o.deps.createAutoGate ?? createSquadrantAutoGate;
  const autoGate = make({
    config: o.config,
    env: o.env,
    ...(o.project ? { project: o.project } : {}),
    ...(o.deps.sendEvent ? { sendBlocked: o.deps.sendEvent } : {}),
    log: o.log,
  });
  const out = await autoGate.decideClaudeHookPayload(o.deps.rawPayload ?? "");
  if (out === undefined) {
    // ask/yield: emit nothing to Claude so the normal dialog appears; the
    // package already fired exactly one task.blocked for a crew.
    o.log("gate auto-gate: ask/yield — normal dialog");
    return { decision: "ask", tier: 2, reason: "auto-gate: ask/yield" };
  }
  o.stdout(out);
  let decision: "allow" | "deny" = "allow";
  try {
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { decision?: { behavior?: unknown } } };
    if (parsed?.hookSpecificOutput?.decision?.behavior === "deny") decision = "deny";
  } catch {
    // Defensive only — formatClaudeHookOutput always emits well-formed JSON.
  }
  o.log(`gate auto-gate ${decision}`);
  return { decision, tier: 2, reason: "auto-gate" };
}

/**
 * Evaluate one PermissionRequest and emit the right hook output. Returns the
 * evaluation so callers/tests can assert the decision.
 */
export async function runGatePermissionRequest(deps: GateHookDeps): Promise<GateEvaluation> {
  const env = deps.env ?? process.env;
  const payload = (deps.payload ?? {}) as Record<string, unknown>;
  const p = payload as {
    tool_name?: unknown;
    tool_input?: unknown;
    permission_mode?: unknown;
    cwd?: unknown;
    transcript_path?: unknown;
    session_id?: unknown;
  };

  const taskId = env.SQUADRANT_CREW_TASK_ID;
  const project = env.SQUADRANT_CREW_PROJECT;

  // Not a squadrant crew/side/captain session (an operator's own claude): never
  // touch it. Single source of truth is isGateSession — the same predicate
  // evaluatePermissionRequest uses, so the two can never disagree (#772).
  if (!isGateSession(env)) {
    return { decision: "yield", reason: "not a squadrant crew/side/captain session" };
  }

  const stdout = deps.stdout ?? (() => {});
  const log = deps.log ?? ((m: string) => process.stderr.write(`[squadrant] ${m}\n`));
  const config = deps.config ?? (deps.loadConfigFn ?? loadConfig)();

  // P6-C (#828): `mode=on + engine=auto-gate` hands the prompt to the standalone
  // package. The default (`router`) keeps the U7 path below byte-for-byte.
  const gate = config.defaults.gate;
  if (resolveGateMode(env, gate) === "on" && resolveGateEngine(env, gate) === "auto-gate") {
    return runAutoGateClaudeHook({ deps, env, config, project, stdout, log });
  }

  const cwd =
    deps.cwd ??
    (typeof p.cwd === "string" && p.cwd ? p.cwd : env.SQUADRANT_CREW_CWD ?? process.cwd());
  const transcriptPath =
    typeof p.transcript_path === "string" && p.transcript_path
      ? p.transcript_path
      : deriveTranscriptPath(
          typeof p.session_id === "string" ? p.session_id : "",
          cwd,
        ) ?? undefined;

  const evaluation = await evaluatePermissionRequest({
    toolName: typeof p.tool_name === "string" ? p.tool_name : "",
    toolInput: p.tool_input,
    permissionMode: typeof p.permission_mode === "string" ? p.permission_mode : undefined,
    cwd,
    env,
    config,
    userIntent: (deps.readIntent ?? readUserIntent)(transcriptPath),
    cache: deps.cache ?? new GateDecisionCache(),
    fetchImpl: deps.fetchImpl,
    log,
  });

  if (evaluation.decision === "allow" || evaluation.decision === "deny") {
    log(
      `gate ${evaluation.decision}` +
        ` (tier ${evaluation.tier ?? "?"}${evaluation.cached ? ", cached" : ""}): ${evaluation.reason}`,
    );
    stdout(
      formatPermissionDecision(
        evaluation.decision,
        evaluation.decision === "deny"
          ? `Blocked by the squadrant permission gate: ${evaluation.reason}`
          : undefined,
      ),
    );
    return evaluation;
  }

  // ask / yield: leave the normal dialog intact and preserve #560 signalling.
  if (taskId && project && deps.sendEvent) {
    const ev = mapClaudeHookToEvent("PermissionRequest", payload, taskId);
    if (ev) {
      try {
        await deps.sendEvent(project, ev);
      } catch {
        // Daemon down: do NOT block claude. Hook contract requires exit 0.
      }
    }
  }
  return evaluation;
}

const DEFAULT_EVENT = "permission-request";

// ── `squadrant gate mode [on|off|auto]` (#854) ────────────────────────────────
// Mirrors the effort-dial pattern (packages/cli/src/commands/effort.ts):
// get/set on `defaults.gate.mode`, env-override-aware, no daemon bounce (the
// key is not in DAEMON_CACHED_PREFIXES — resolveGateMode reads it live).

export interface GateModeGetResult {
  mode: GateMode;
  source: "env" | "config" | "default";
}

/** Same precedence as resolveGateMode (env > config > "auto"), plus which tier
 *  the effective value came from, for the CLI/Telegram-facing display. */
export function runGateModeGet(
  configPath = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): GateModeGetResult {
  const config = loadConfig(configPath);
  const mode = resolveGateMode(env, config.defaults.gate);
  const source: GateModeGetResult["source"] =
    env.SQUADRANT_GATE !== undefined && isGateMode(env.SQUADRANT_GATE)
      ? "env"
      : config.defaults.gate?.mode && isGateMode(config.defaults.gate.mode)
        ? "config"
        : "default";
  return { mode, source };
}

export interface GateModeSetResult {
  old: GateMode;
  next: GateMode;
}

/** Writes `defaults.gate.mode`. Rejects an invalid value without touching disk. */
export function runGateModeSet(value: string, configPath = DEFAULT_CONFIG_PATH): GateModeSetResult {
  if (!isGateMode(value)) {
    throw new Error(`Invalid gate mode '${value}'. Valid values: ${GATE_MODES.join(" | ")}`);
  }
  const config = loadConfig(configPath);
  const old: GateMode =
    config.defaults.gate?.mode && isGateMode(config.defaults.gate.mode) ? config.defaults.gate.mode : "auto";
  config.defaults.gate = { ...config.defaults.gate, mode: value };
  saveConfig(config, configPath);
  return { old, next: value };
}

export interface GateStatusResult extends GateModeGetResult {
  engine: "router" | "auto-gate";
  model: string | undefined;
  /** Whether the engine's credential resolves — value is NEVER read/printed. */
  credentialPresent: boolean;
}

/** Nice-to-have (#854): resolved classifier model + credential presence, never
 *  the credential value itself. */
export function runGateStatus(
  configPath = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): GateStatusResult {
  const config = loadConfig(configPath);
  const { mode, source } = runGateModeGet(configPath, env);
  const engine = resolveGateEngine(env, config.defaults.gate);
  const model = resolveClassifierModel(env, config);
  const credentialPresent =
    engine === "auto-gate"
      ? Boolean(env.TYPESAFE_API_KEY)
      : Boolean(config.defaults.router?.apiKey ?? (config.defaults.router?.apiKeyEnv ? env[config.defaults.router.apiKeyEnv] : undefined));
  return { mode, source, engine, model, credentialPresent };
}

export function gateCommand(): Command {
  const gate = new Command("gate").description(
    "Permission gate (#782/#854): get/set defaults.gate.mode; 'claude <event>' is an internal hook handler",
  );

  gate
    .command("mode [value]")
    .description("Get or set the permission gate mode (on | off | auto)")
    .action((value: string | undefined) => {
      if (value === undefined) {
        const result = runGateModeGet();
        console.log(chalk.bold("Gate mode:"), chalk.cyan(result.mode), chalk.dim(`(${result.source})`));
        return;
      }
      let result: GateModeSetResult;
      try {
        result = runGateModeSet(value);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
      console.log(chalk.green(`✔ gate mode: ${result.old} → ${result.next}`));
      console.log(chalk.dim("No daemon bounce needed — defaults.gate.mode is read live."));
      if (isGateMode(process.env.SQUADRANT_GATE ?? "") && process.env.SQUADRANT_GATE !== result.next) {
        console.log(chalk.yellow(`Note: SQUADRANT_GATE=${process.env.SQUADRANT_GATE} in this session still overrides the config value.`));
      }
    });

  gate
    .command("status")
    .description("Show the effective gate mode, engine, classifier model, and credential presence")
    .action(() => {
      const result = runGateStatus();
      console.log(chalk.bold("Gate mode:"), chalk.cyan(result.mode), chalk.dim(`(${result.source})`));
      console.log(chalk.bold("Engine:"), result.engine);
      console.log(chalk.bold("Classifier model:"), result.model ?? chalk.dim("(unset)"));
      console.log(chalk.bold("Credential:"), result.credentialPresent ? chalk.green("present") : chalk.yellow("absent"));
    });

  gate
    .command("claude <event>", { hidden: true })
    .description("internal: classify a claude PermissionRequest with the configured router model")
    .action(async (event: string) => {
      // Drain stdin FIRST (Claude's hook JSON), then exit 0 unconditionally —
      // a non-zero exit would block the conversation.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk as string;
      } catch {
        /* ignore */
      }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try {
          payload = JSON.parse(stdin);
        } catch {
          /* ignore malformed */
        }
      }

      if (event !== DEFAULT_EVENT) {
        process.exit(0);
      }

      await runGatePermissionRequest({
        payload,
        rawPayload: stdin,
        env: process.env,
        stdout: (s) => process.stdout.write(s),
        sendEvent: async (project, ev) => {
          await sendRequest(SOCK, { kind: "event", project, event: ev });
        },
      });
      process.exit(0);
    });

  return gate;
}
