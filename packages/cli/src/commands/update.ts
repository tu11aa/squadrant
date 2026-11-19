// squadrant update (#1150): detect the install manager, install squadrant@latest (or --to),
// verify the installed binary, heal the daemon onto the new code, list captains to relaunch.
// Never runs automatically. Pure planning is split from I/O so refusals are unit-tested.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import {
  detectInstallManager,
  installArgvFor,
  fetchLatestRelease,
  isNewerVersion,
  isBelowMinSafe,
  type InstallManager,
  type ReleaseInfo,
} from "@squadrant/shared";
import type { ComponentHealth } from "@squadrant/core";
import { queryHealth } from "./health-view.js";

/** A global registry install lives under node_modules/squadrant/; a dev, linked or git checkout does not. */
export function isGlobalInstall(modulePath: string): boolean {
  return /[\\/]node_modules[\\/]squadrant[\\/]/.test(modulePath);
}

export interface UpdatePlanInput {
  modulePath: string;
  manager: InstallManager;
  /** `--to` value, or undefined for @latest. */
  to?: string;
  liveCrews: string[];
  force: boolean;
}

export type UpdatePlan =
  | { ok: false; reason: string }
  | { ok: true; install: string[]; verify: string[]; heal: string[] };

export function planUpdate(i: UpdatePlanInput): UpdatePlan {
  if (!isGlobalInstall(i.modulePath)) {
    return { ok: false, reason: "this squadrant is a dev/linked/git checkout, not a registry install — update it with git pull + pnpm build." };
  }
  if (i.liveCrews.length > 0 && !i.force) {
    return { ok: false, reason: `${i.liveCrews.length} live crew(s) (${i.liveCrews.join(", ")}) — the daemon restart would interrupt them. Wait, or pass --force.` };
  }
  return {
    ok: true,
    install: installArgvFor(i.manager, i.to ?? "latest"),
    verify: ["squadrant", "--version"],
    heal: ["squadrant", "heal", "daemon"],
  };
}

export function liveCrewsFrom(health: ComponentHealth[] | null): string[] {
  return (health ?? []).filter((c) => c.kind === "crew" && (c.state === "alive" || c.state === "stale")).map((c) => `${c.project}/${c.ref}`);
}

export function liveCaptainsFrom(health: ComponentHealth[] | null): string[] {
  return (health ?? []).filter((c) => c.kind === "captain" && (c.state === "alive" || c.state === "stale")).map((c) => c.project);
}

export function formatCheck(current: string, rel: ReleaseInfo | null): string[] {
  if (!rel) return ["could not reach the npm registry"];
  const lines = [
    `current:  ${current}`,
    `latest:   ${rel.version}${isNewerVersion(rel.version, current) ? "" : " (up to date)"}`,
    `level:    ${rel.level}`,
  ];
  if (rel.reason) lines.push(`reason:   ${rel.reason}`);
  if (rel.minSafe) lines.push(`minSafe:  ${rel.minSafe}${isBelowMinSafe(current, rel.minSafe) ? "  ← you are BELOW this" : ""}`);
  return lines;
}

/** Version of the running install (dist/index.js sits next to ../package.json). */
export function installedVersion(modulePath: string = fileURLToPath(import.meta.url)): string {
  return JSON.parse(readFileSync(join(dirname(modulePath), "..", "package.json"), "utf-8")).version as string;
}

export interface UpdateDeps {
  modulePath: string;
  current: string;
  manager: InstallManager;
  fetchRelease: () => Promise<ReleaseInfo | null>;
  health: () => Promise<ComponentHealth[] | null>;
  /** Runs argv, returns stdout. Throws on non-zero exit. */
  exec: (argv: string[]) => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface UpdateOpts { check?: boolean; dryRun?: boolean; force?: boolean; to?: string }

/** Returns exit code. */
export async function runUpdate(opts: UpdateOpts, d: UpdateDeps): Promise<number> {
  if (opts.check) {
    const rel = await d.fetchRelease();
    for (const l of formatCheck(d.current, rel)) d.out(l);
    return rel ? 0 : 1;
  }

  // Resolve "nothing to install" first, so it never reads as a refusal.
  let expected = opts.to?.replace(/^v/, "");
  if (!expected) {
    const rel = await d.fetchRelease();
    if (!rel) { d.err("update: could not resolve the latest version from the npm registry"); return 1; }
    if (!isNewerVersion(rel.version, d.current)) { d.out(`already up to date (${d.current})`); return 0; }
    expected = rel.version;
  }

  const health = await d.health();
  const plan = planUpdate({ modulePath: d.modulePath, manager: d.manager, to: opts.to, liveCrews: liveCrewsFrom(health), force: !!opts.force });
  if (!plan.ok) {
    d.err(`update refused: ${plan.reason}`);
    return 1;
  }

  if (opts.dryRun) {
    d.out("dry run — would run:");
    for (const c of [plan.install, plan.verify, plan.heal]) d.out(`  ${c.join(" ")}`);
    return 0;
  }

  d.out(`installing squadrant ${expected}: ${plan.install.join(" ")}`);
  try { d.exec(plan.install); } catch (e) { d.err(`update: install failed: ${(e as Error).message}`); return 1; }

  let installed = "";
  try { installed = d.exec(plan.verify).trim(); } catch (e) { d.err(`update: could not run the installed squadrant: ${(e as Error).message}`); return 1; }
  if (installed.split("\n")[0].trim() !== expected) {
    d.err(`update: installed binary reports "${installed}", expected ${expected} — daemon NOT restarted. Check which squadrant is first on PATH.`);
    return 1;
  }
  d.out(`✔ installed ${installed}`);

  try { d.exec(plan.heal); } catch (e) { d.err(`update: heal daemon failed: ${(e as Error).message}`); return 1; }
  d.out("✔ daemon restarted on the new code");

  const captains = liveCaptainsFrom(health);
  if (captains.length > 0) {
    d.out("captains still on the old code — relaunch each with /squadrant:restart (or squadrant captain restart <project>):");
    for (const p of captains) d.out(`  ${p}`);
  }
  return 0;
}

export const updateCommand = new Command("update")
  .description("Install the latest squadrant, restart the daemon on it, list captains to relaunch (never automatic)")
  .option("--check", "report current/latest/level/reason/minSafe only")
  .option("--dry-run", "print the commands without running them")
  .option("--to <version>", "install this version instead of latest")
  .option("--force", "update even while crews are live")
  .action(async (opts: UpdateOpts) => {
    const modulePath = fileURLToPath(import.meta.url);
    const code = await runUpdate(opts, {
      modulePath,
      current: installedVersion(modulePath),
      manager: detectInstallManager(modulePath),
      fetchRelease: async () => {
        // The registry transport is unref'd (so the passive notifier never delays exit);
        // here the result is the whole point, so hold the loop open until it settles.
        const keepAlive = setTimeout(() => {}, 6000);
        try { return await fetchLatestRelease(undefined, 5000); } finally { clearTimeout(keepAlive); }
      },
      health: () => queryHealth(),
      exec: (argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }),
      out: (l) => console.log(l),
      err: (l) => console.error(chalk.red(l)),
    });
    process.exitCode = code;
  });
