// packages/cli/src/commands/dev.ts
//
// `squadrant dev up|down` — live-test a branch build on a throwaway daemon
// (#1046). The dev daemon is a plain detached process (never launchd) with its
// own config, state and socket under one root dir; an isolated SQUADRANT_CONFIG
// is what keeps every write off the production daemon and ~/.claude (see
// isolatedConfigDir in @squadrant/shared). `down` kills it and deletes the root.
import { Command } from "commander";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultConfig, isolatedConfigDir } from "@squadrant/shared";
import { isDaemonSocketLive } from "@squadrant/core";
import { createCmuxDriver } from "@squadrant/workspaces";

/** Written at `up`; `down` deletes only a root that carries it. */
const MARKER = ".squadrant-dev";

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (m: string) => process.stderr.write(`${m}\n`);

/** Same default whether called from a plain shell or from the dev shell itself. */
function defaultRoot(): string {
  return isolatedConfigDir() ?? join(tmpdir(), "squadrant-dev");
}

/** The package root of the running CLI (`<root>/dist/index.js`). */
function selfPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(root: string): number | undefined {
  try { return Number(readFileSync(join(root, "daemon.pid"), "utf8").trim()) || undefined; } catch { return undefined; }
}

/** The lines to `eval` so `squadrant` in that shell is the dev build talking to the dev daemon. */
export function devEnvLines(root: string): string[] {
  return [
    `export SQUADRANT_CONFIG=${shq(join(root, "config.json"))}`,
    `export SQUADRANT_WORKSPACE_DIR=${shq(join(root, "workspace"))}`,
    `export PATH=${shq(join(root, "bin"))}:"$PATH"`,
  ];
}

async function up(opts: { from?: string; project: string; root?: string; build?: boolean }): Promise<number> {
  const from = resolve(opts.from ?? selfPackageRoot());
  const root = resolve(opts.root ?? defaultRoot());
  const sock = join(root, "squadrant.sock");
  if (await isDaemonSocketLive(sock)) {
    err(`dev up: a dev daemon is already running at ${root} — run 'squadrant dev down' first`);
    return 1;
  }
  if (opts.build) execFileSync("pnpm", ["build"], { cwd: from, stdio: ["ignore", process.stderr, process.stderr] });
  const daemonEntry = join(from, "dist", "squadrantd.js");
  const cliEntry = join(from, "dist", "index.js");
  if (!existsSync(daemonEntry) || !existsSync(cliEntry)) {
    err(`dev up: no build at ${from}/dist — run 'pnpm build' there, or pass --build`);
    return 1;
  }

  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, MARKER), `${from}\n`);

  // Throwaway project: an empty git repo, registered in a fresh default config.
  // Nothing is copied from the operator's config (no telegram, router or projects).
  const projectDir = join(root, opts.project);
  if (!existsSync(join(projectDir, ".git"))) {
    mkdirSync(projectDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
    execFileSync("git", ["-c", "user.name=squadrant-dev", "-c", "user.email=dev@squadrant.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: projectDir });
  }
  const config = getDefaultConfig();
  config.hubVault = join(root, "hub");
  config.projects[opts.project] = {
    path: projectDir,
    captainName: `⚓ ${opts.project}-captain`,
    spokeVault: join(root, "hub", "spokes", opts.project),
    host: "local",
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
  try { ensureClaudeTrust(trustSpellings(projectDir)); } catch (e) { err(`dev up: could not pre-trust ${projectDir}: ${(e as Error).message}`); }

  // `squadrant` on the dev shell's PATH, and on every dev session's PATH
  // (isolatedSessionEnvPrefix picks this file up).
  const shim = join(root, "bin", "squadrant");
  writeFileSync(shim, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(cliEntry)} "$@"\n`);
  chmodSync(shim, 0o755);

  // Detached, not launchd. Crew/role markers from the calling shell are dropped
  // so the daemon never mistakes itself for a session.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SQUADRANT_CONFIG: join(root, "config.json"),
    SQUADRANT_WORKSPACE_DIR: join(root, "workspace"),
  };
  for (const k of ["SQUADRANT_CREW_TASK_ID", "SQUADRANT_CREW_PROJECT", "SQUADRANT_ROLE", "SQUADRANT_STATE_DIR", "SQUADRANT_DEV_DAEMON"]) delete env[k];
  const log = openSync(join(root, "daemon.log"), "a");
  const child = spawn(process.execPath, [daemonEntry], { cwd: root, env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  writeFileSync(join(root, "daemon.pid"), `${child.pid}\n`);

  for (let i = 0; i < 60 && !(await isDaemonSocketLive(sock)); i++) await sleep(250);
  if (!(await isDaemonSocketLive(sock))) {
    err(`dev up: daemon did not open ${sock} within 15s — see ${join(root, "daemon.log")}`);
    return 1;
  }
  err(`dev daemon up: pid ${child.pid}, build ${from}`);
  err(`  root ${root}   project '${opts.project}' at ${projectDir}`);
  err(`  log  ${join(root, "daemon.log")}`);
  err(`Point a shell at it:  eval "$(squadrant dev env${opts.root ? ` --root ${shq(root)}` : ""})"`);
  process.stdout.write(devEnvLines(root).join("\n") + "\n");
  return 0;
}

/**
 * Pre-trusts `paths` in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted: true` — the documented
 * key Claude Code's own error text points at), so the dev captain never opens on the folder-trust dialog.
 * Claude keys trust by the resolved path (/private/var/… on macOS) and walks up from cwd, so callers pass
 * both spellings. The file is shared and rewritten by every running Claude Code session, so this is a
 * single read-modify-write of just these keys (atomic rename), re-checked after the write. Returns how many
 * entries it added or flipped; `dev down` prunes them with `pruneClaudeProjects`.
 */
export function ensureClaudeTrust(paths: string[], claudeJson: string = join(homedir(), ".claude.json")): number {
  const want = [...new Set(paths)];
  let added = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    let data: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    try { data = JSON.parse(readFileSync(claudeJson, "utf8")); } catch { return added; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return added;
    if (data.projects !== undefined && (typeof data.projects !== "object" || data.projects === null || Array.isArray(data.projects))) return added;
    const projects = (data.projects ??= {});
    const missing = want.filter((k) => projects[k]?.hasTrustDialogAccepted !== true);
    if (missing.length === 0) return added;
    for (const k of missing) projects[k] = { ...(typeof projects[k] === "object" ? projects[k] : {}), hasTrustDialogAccepted: true };
    const target = realpathSync(claudeJson); // keep a symlinked ~/.claude.json a symlink
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: statSync(target).mode & 0o777 });
    renameSync(tmp, target);
    added = Math.max(added, missing.length);
  }
  return added;
}

/** Both spellings of `dir` (it must exist) — see ensureClaudeTrust. */
export function trustSpellings(dir: string): string[] {
  return [...new Set([dir, realpathSync(dir)])];
}

/** Drops the `projects` entries of `~/.claude.json` that live under `roots` (the trust `up` seeded, plus anything Claude recorded for the dev project). Every other key is left alone; the file is rewritten atomically, and only when something changed. */
export function pruneClaudeProjects(roots: string[], claudeJson: string = join(homedir(), ".claude.json")): number {
  let data: { projects?: Record<string, unknown> };
  try { data = JSON.parse(readFileSync(claudeJson, "utf8")); } catch { return 0; }
  const projects = data?.projects;
  if (!projects || typeof projects !== "object") return 0;
  const under = (k: string) => roots.some((r) => k === r || k.startsWith(r + sep));
  const drop = Object.keys(projects).filter(under);
  if (drop.length === 0) return 0;
  for (const k of drop) delete projects[k];
  const tmp = `${claudeJson}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: statSync(claudeJson).mode & 0o777 });
  renameSync(tmp, claudeJson);
  return drop.length;
}

async function down(opts: { root?: string }): Promise<number> {
  const root = resolve(opts.root ?? defaultRoot());
  if (!existsSync(join(root, MARKER))) {
    err(`dev down: ${root} is not a dev root (no ${MARKER}) — nothing removed`);
    return 1;
  }
  // Close the dev projects' captain workspaces (and their crew tabs) first.
  try {
    const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as { projects?: Record<string, { captainName: string }> };
    const runtime = createCmuxDriver();
    for (const p of Object.values(cfg.projects ?? {})) {
      const ws = await runtime.status(p.captainName).catch(() => null);
      if (ws) await runtime.stop(ws.id).catch((e) => err(`dev down: could not close '${p.captainName}': ${(e as Error).message}`));
    }
  } catch { /* no config — nothing to close */ }
  const pid = readPid(root);
  if (pid && isAlive(pid)) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(250);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  // Claude keys trust by the resolved path (/private/tmp on macOS), so match both spellings.
  const roots = [root, realpathSync(root)];
  rmSync(root, { recursive: true, force: true });
  try {
    const n = pruneClaudeProjects([...new Set(roots)]);
    if (n > 0) err(`dev down: removed ${n} trust entr${n === 1 ? "y" : "ies"} from ~/.claude.json`);
  } catch (e) { err(`dev down: could not prune ~/.claude.json: ${(e as Error).message}`); }
  err(`dev daemon down${pid ? ` (pid ${pid})` : ""}; removed ${root}`);
  return 0;
}

export const devCommand = new Command("dev")
  .description("Live-test a branch build on a throwaway dev daemon (never launchd, never ~/.claude/settings.json)")
  .addCommand(
    new Command("up")
      .description("Start a dev daemon from a build, register a throwaway project, print the env to export")
      .option("--from <dir>", "package root whose dist/ to run (default: this CLI's own)")
      .option("--project <name>", "throwaway project name", "devtest")
      .option("--root <dir>", "dev root (default: $SQUADRANT_CONFIG's dir, else $TMPDIR/squadrant-dev)")
      .option("--build", "run 'pnpm build' in --from first")
      .action(async (opts) => process.exit(await up(opts))),
  )
  .addCommand(
    new Command("down")
      .description("Stop the dev daemon and delete its root")
      .option("--root <dir>", "dev root (default: $SQUADRANT_CONFIG's dir, else $TMPDIR/squadrant-dev)")
      .action(async (opts) => process.exit(await down(opts))),
  )
  .addCommand(
    new Command("env")
      .description("Print the export lines for a running dev root")
      .option("--root <dir>", "dev root (default: $SQUADRANT_CONFIG's dir, else $TMPDIR/squadrant-dev)")
      .action((opts: { root?: string }) => {
        process.stdout.write(devEnvLines(resolve(opts.root ?? defaultRoot())).join("\n") + "\n");
      }),
  );
