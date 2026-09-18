// packages/cli/src/commands/whoami.ts
//
// #669: `squadrant whoami` — resolve the agent session that is calling.
// Read-only; never touches the daemon.
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveHome } from "@squadrant/shared";
import { readCaptainAddress, createStore, realpathOrSelf } from "@squadrant/core";
import { readClaudeStatusBySocketPath } from "@squadrant/agents";
import { resolveWhoami, type WhoamiDeps, type WhoamiResult } from "../lib/whoami.js";

export interface WhoamiBuildOptions extends Partial<WhoamiDeps> {
  /** Injectable for tests; defaults to DEFAULT_CONFIG_PATH. */
  configPath?: string;
  /** Injectable for tests; defaults to ~/.config/squadrant/state. */
  stateRoot?: string;
}

/** Wire the real sources (config, state root, claude registry) into WhoamiDeps. */
export function buildWhoamiDeps(opts: WhoamiBuildOptions = {}): WhoamiDeps {
  const { configPath, stateRoot, ...over } = opts;
  const config = loadConfig(configPath);
  const projects = Object.fromEntries(
    Object.entries(config.projects).map(([n, p]) => [n, resolveHome(p.path)]),
  );
  const root = stateRoot ?? path.join(os.homedir(), ".config", "squadrant", "state");
  const store = createStore(root);

  const merged: WhoamiDeps = {
    env: process.env,
    cwd: process.cwd(),
    projects,
    readCaptain: (project) => readCaptainAddress(root, project),
    readTask: (project, id) => store.get(project, id) ?? null,
    readClaudeBySocket: (socket) => readClaudeStatusBySocketPath(socket),
    ...over,
  };

  // macOS canonicalizes /tmp → /private/tmp, so a raw prefix compare misses a
  // live captain in a symlinked dir (the same trap registry.ts documents).
  // Normalize both sides of the cwd → project match.
  return {
    ...merged,
    cwd: realpathOrSelf(merged.cwd),
    projects: Object.fromEntries(
      Object.entries(merged.projects).map(([n, p]) => [n, realpathOrSelf(p)]),
    ),
  };
}

export function runWhoami(opts: WhoamiBuildOptions = {}): WhoamiResult {
  return resolveWhoami(buildWhoamiDeps(opts));
}

const dash = (v: string | null): string => (v === null || v === "" ? "-" : v);

export function formatWhoami(result: WhoamiResult): string {
  const r = result.record;
  const lines = [
    `project  ${dash(r.project)}`,
    `role     ${dash(r.role)}`,
    `agent    ${dash(r.agent)}`,
    `session  ${dash(r.sessionId)}`,
    `address  ${dash(r.address)}`,
    `source   ${r.source}`,
  ];
  if (r.note) lines.push(`note     ${r.note}`);
  return lines.join("\n");
}

export const whoamiCommand = new Command("whoami")
  .description("Show the agent session calling this command (read-only)")
  .option("--json", "emit machine-readable JSON")
  .action((opts: { json?: boolean }) => {
    const result = runWhoami();
    if (opts.json) {
      console.log(JSON.stringify(result.record, null, 2));
    } else {
      console.log(formatWhoami(result));
      if (!result.ok) {
        console.error(chalk.yellow("\n  Could not identify a squadrant agent session for this invocation."));
      }
    }
    if (!result.ok) process.exitCode = 1;
  });
