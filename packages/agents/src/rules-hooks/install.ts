// Rules KB delivery adapters for codex / gemini / opencode (#900). Each installer writes the agent's own
// hook (or plugin) config so it calls `squadrant hooks <agent> <sub>`, the same core as claude's (#899).
// Hook output formats are from each agent's docs and still need a live check (see PR #900).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RulesHookAgent = "codex" | "gemini" | "opencode";
export interface RulesHooksInstallOpts {
  /** Config file/dir override (tests). Never defaults to anything outside the agent's own config home. */
  target?: string;
  /** CLI prefix baked into the hook command. */
  cli?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}
export interface RulesHooksInstallResult { path: string; changed: boolean; skipped?: "foreign-file" }

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[]; [k: string]: unknown };

interface HookSpec { event: string; sub: string; matcher?: string }

const CODEX_HOOKS: HookSpec[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "prompt-submit" },
  { event: "PostToolUse", sub: "post-tool-use", matcher: "Bash" },
];
const GEMINI_HOOKS: HookSpec[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "BeforeAgent", sub: "before-agent" },
  { event: "AfterTool", sub: "after-tool", matcher: "read_file" },
];

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix it before installing rules hooks`);
  }
}

/** Idempotent, non-clobbering: our command is replaced in place, every other entry is kept. */
function mergeHooks(
  root: Record<string, unknown>, agent: string, specs: HookSpec[], cli: string, timeout: number,
): Record<string, unknown> {
  const hooks = (typeof root.hooks === "object" && root.hooks !== null ? { ...(root.hooks as Record<string, unknown>) } : {});
  for (const { event, sub, matcher } of specs) {
    const command = `${cli} hooks ${agent} ${sub}`;
    const owned = (e: HookEntry) => e.hooks?.some((h) => h.command?.includes(`hooks ${agent} ${sub}`));
    const entries = (Array.isArray(hooks[event]) ? hooks[event] as HookEntry[] : []).filter((e) => !owned(e));
    entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] });
    hooks[event] = entries;
  }
  return { ...root, hooks };
}

function writeIfChanged(file: string, next: string, dryRun?: boolean): RulesHooksInstallResult {
  let prev: string | null = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const changed = prev !== next;
  if (changed && !dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
  }
  return { path: file, changed };
}

export function installCodexRulesHooks(opts: RulesHooksInstallOpts = {}): RulesHooksInstallResult {
  const env = opts.env ?? process.env;
  const file = opts.target ?? path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "hooks.json");
  const merged = mergeHooks(readJson(file), "codex", CODEX_HOOKS, opts.cli ?? "squadrant", 5);
  return writeIfChanged(file, JSON.stringify(merged, null, 2) + "\n", opts.dryRun);
}

export function installGeminiRulesHooks(opts: RulesHooksInstallOpts = {}): RulesHooksInstallResult {
  const file = opts.target ?? path.join(os.homedir(), ".gemini", "settings.json");
  // gemini hook timeouts are milliseconds.
  const merged = mergeHooks(readJson(file), "gemini", GEMINI_HOOKS, opts.cli ?? "squadrant", 5000);
  return writeIfChanged(file, JSON.stringify(merged, null, 2) + "\n", opts.dryRun);
}

export const OPENCODE_PLUGIN_MARKER = "// squadrant:managed rules plugin";

export function opencodeRulesPlugin(cli = "squadrant"): string {
  return `${OPENCODE_PLUGIN_MARKER} (#900) — do not edit; re-run \`squadrant rules install-hooks --agent opencode\`
import { spawnSync } from "node:child_process";

const CLI = ${JSON.stringify(cli)};

// Calls the same core as the claude hooks; any failure or empty answer injects nothing.
function rules(sub, cwd, payload) {
  try {
    const r = spawnSync(CLI, ["hooks", "opencode", sub], { input: JSON.stringify({ ...payload, cwd }), cwd, encoding: "utf8", timeout: 3000 });
    return JSON.parse(r.stdout || "{}").hookSpecificOutput?.additionalContext ?? null;
  } catch { return null; }
}

export const SquadrantRules = async ({ directory }) => {
  const args = new Map();
  return {
    "chat.message": async (input, output) => {
      const prompt = (output.parts ?? []).filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\\n");
      if (!prompt) return;
      const ctx = rules("chat-message", directory, { session_id: input.sessionID, prompt });
      if (ctx) output.parts.push({ id: "prt_squadrant_rules_" + Date.now(), sessionID: input.sessionID, messageID: output.message?.id, type: "text", text: ctx, synthetic: true });
    },
    "tool.execute.before": async (input, output) => { args.set(input.callID, output.args); },
    "tool.execute.after": async (input, output) => {
      const toolInput = args.get(input.callID);
      args.delete(input.callID);
      if (input.tool !== "read" || !toolInput) return;
      const ctx = rules("tool-after", directory, { session_id: input.sessionID, tool_name: "read", tool_input: toolInput });
      if (ctx) output.output = (output.output ?? "") + "\\n\\n" + ctx;
    },
  };
};
`;
}

export function installOpencodeRulesHooks(opts: RulesHooksInstallOpts = {}): RulesHooksInstallResult {
  const env = opts.env ?? process.env;
  const file = opts.target ?? path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "plugin", "squadrant-rules.js");
  try {
    if (!fs.readFileSync(file, "utf8").startsWith(OPENCODE_PLUGIN_MARKER)) return { path: file, changed: false, skipped: "foreign-file" };
  } catch { /* absent: ours to create */ }
  return writeIfChanged(file, opencodeRulesPlugin(opts.cli), opts.dryRun);
}

export function installRulesHooks(agent: RulesHookAgent, opts: RulesHooksInstallOpts = {}): RulesHooksInstallResult {
  return { codex: installCodexRulesHooks, gemini: installGeminiRulesHooks, opencode: installOpencodeRulesHooks }[agent](opts);
}
