// src/dashboard/probes.ts
//
// Tier 3 (external dependencies) + Tier 4 (config integrity) probes for the web
// dashboard. These live in the DASHBOARD process, never the daemon: the daemon
// runs under launchd and is outside cmux's process lineage, so it cannot probe
// cmux (the "lineage wall"). Every probe is behind an injectable runner and is
// independently try/caught with a short timeout — a thrown or hung probe yields
// `unknown` and NEVER propagates, so one bad probe can never crash a tick.
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { CockpitConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { resolveCmuxBin } from "../lib/cmux-bin.js";

export type ProbeState = "alive" | "stale" | "gone" | "unknown";

export interface Probe {
  state: ProbeState;
  /** Human-facing context for a degraded/unknown cell. */
  detail?: string;
}

export interface ExternalProbes {
  cmux: Probe;
  agentClis: Array<{ cli: string } & Probe>;
  vaults: {
    hub: { path: string } & Probe;
    spokes: Array<{ project: string; path: string } & Probe>;
  };
  config: {
    parseable: Probe;
    projectPaths: Array<{ project: string; path: string } & Probe>;
    sessions: Probe;
  };
}

/** Low-level I/O the probes depend on. Tests inject fakes; the dashboard process
 *  injects {@link defaultProbeRunners}. */
export interface ProbeRunners {
  /** cmux reachable (e.g. `cmux --version` exited 0). */
  probeCmuxBin: () => Promise<boolean>;
  /** an agent CLI resolves on PATH. */
  probeOnPath: (cli: string) => Promise<boolean>;
  /** a directory/file exists (sync stat). */
  pathExists: (p: string) => boolean;
  /** load + parse config.json; throws when unparseable. */
  loadConfig: () => CockpitConfig;
  /** distinct templateHash values recorded in sessions.json; throws when unreadable. */
  loadSessionsHashes: () => string[];
}

const DEFAULT_TIMEOUT_MS = 2000;
const AGENT_CLIS = ["claude", "codex", "gemini", "opencode"] as const;

/** Reject a promise that outlives `ms`, clearing the timer either way. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

// ── Tier 3 — external dependencies ────────────────────────────────────────────

export async function probeCmux(run: ProbeRunners, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Probe> {
  try {
    const ok = await withTimeout(run.probeCmuxBin(), timeoutMs);
    return ok ? { state: "alive" } : { state: "gone", detail: "cmux not reachable" };
  } catch {
    return { state: "unknown" };
  }
}

export async function probeAgentClis(
  run: ProbeRunners,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Array<{ cli: string } & Probe>> {
  return Promise.all(
    AGENT_CLIS.map(async (cli) => {
      try {
        const ok = await withTimeout(run.probeOnPath(cli), timeoutMs);
        return ok ? { cli, state: "alive" as const } : { cli, state: "gone" as const, detail: `${cli} not on PATH` };
      } catch {
        return { cli, state: "unknown" as const };
      }
    }),
  );
}

/** Hub vault is alive only when its directory AND its `.obsidian/` both exist. */
function vaultProbe(run: ProbeRunners, dir: string): Probe {
  try {
    if (!dir) return { state: "unknown", detail: "no vault configured" };
    if (!run.pathExists(dir)) return { state: "gone", detail: "vault directory missing" };
    if (!run.pathExists(join(dir, ".obsidian"))) return { state: "gone", detail: "no .obsidian/ (not a vault)" };
    return { state: "alive" };
  } catch {
    return { state: "unknown" };
  }
}

/** Spoke vault directories live INSIDE the hub vault and correctly have no
 *  `.obsidian/` of their own. Alive = directory exists; gone = directory missing. */
function spokeProbe(run: ProbeRunners, dir: string): Probe {
  try {
    if (!dir) return { state: "unknown", detail: "no vault configured" };
    if (!run.pathExists(dir)) return { state: "gone", detail: "spoke directory missing" };
    return { state: "alive" };
  } catch {
    return { state: "unknown" };
  }
}

export function probeVaults(run: ProbeRunners, config: CockpitConfig): ExternalProbes["vaults"] {
  return {
    hub: { path: config.hubVault, ...vaultProbe(run, config.hubVault) },
    spokes: Object.entries(config.projects).map(([project, p]) => ({
      project,
      path: p.spokeVault,
      ...spokeProbe(run, p.spokeVault),
    })),
  };
}

// ── Tier 4 — config integrity ─────────────────────────────────────────────────

export function probeProjectPaths(
  run: ProbeRunners,
  config: CockpitConfig,
): Array<{ project: string; path: string } & Probe> {
  return Object.entries(config.projects).map(([project, p]) => {
    try {
      const ok = run.pathExists(p.path);
      return ok
        ? { project, path: p.path, state: "alive" as const }
        : { project, path: p.path, state: "gone" as const, detail: "project path missing" };
    } catch {
      return { project, path: p.path, state: "unknown" as const };
    }
  });
}

/**
 * sessions.json template-drift signal. Re-deriving the exact "current" template
 * hash would couple the dashboard to the launcher's hashing internals + the
 * installed templates dir; instead we surface the honest, dependency-free signal
 * that the recorded sessions disagree: more than one distinct templateHash means
 * some workspaces are running against an older template (drift). One hash =
 * consistent; none recorded = unknown.
 */
export function probeSessions(run: ProbeRunners): Probe {
  try {
    const hashes = run.loadSessionsHashes();
    if (hashes.length === 0) return { state: "unknown", detail: "no sessions recorded" };
    if (hashes.length === 1) return { state: "alive" };
    return { state: "stale", detail: `template drift: ${hashes.length} distinct hashes` };
  } catch {
    return { state: "unknown" };
  }
}

// ── Top-level assembly ────────────────────────────────────────────────────────

/**
 * Run every Tier 3/4 probe and assemble {@link ExternalProbes}. config.json is
 * loaded once (shared by vaults + project-path checks); if it fails to parse the
 * config tier degrades but cmux/CLI probes still run.
 */
export async function runExternalProbes(
  run: ProbeRunners,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExternalProbes> {
  const [cmux, agentClis] = await Promise.all([
    probeCmux(run, timeoutMs),
    probeAgentClis(run, timeoutMs),
  ]);

  let config: CockpitConfig | null = null;
  let parseable: Probe;
  try {
    config = run.loadConfig();
    parseable = { state: "alive" };
  } catch {
    parseable = { state: "gone", detail: "config.json unparseable" };
  }

  const vaults = config
    ? probeVaults(run, config)
    : { hub: { path: "", state: "unknown" as const }, spokes: [] };
  const projectPaths = config ? probeProjectPaths(run, config) : [];
  const sessions = probeSessions(run);

  return { cmux, agentClis, vaults, config: { parseable, projectPaths, sessions } };
}

// ── Default real-I/O runners (dashboard process; not unit-tested) ──────────────

const SESSIONS_PATH = join(homedir(), ".config", "cockpit", "sessions.json");

/** Resolve a bare binary name against the PATH dirs (dependency-free `which`). */
function onPath(cli: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  return dirs.some((d) => existsSync(join(d, cli)));
}

/** Distinct templateHash values recorded across all workspaces in sessions.json. */
function readSessionsHashes(): string[] {
  const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8")) as {
    workspaces?: Record<string, { templateHash?: string }>;
  };
  const hashes = Object.values(raw.workspaces ?? {})
    .map((w) => w.templateHash)
    .filter((h): h is string => typeof h === "string" && h.length > 0);
  return [...new Set(hashes)];
}

/** The real runners used by `cockpit dashboard --web`. */
export function defaultProbeRunners(): ProbeRunners {
  return {
    probeCmuxBin: () =>
      new Promise<boolean>((resolve) => {
        try {
          execFile(resolveCmuxBin(), ["--version"], { timeout: 1500 }, (err) => resolve(!err));
        } catch {
          resolve(false);
        }
      }),
    probeOnPath: async (cli) => onPath(cli),
    pathExists: (p) => existsSync(p),
    loadConfig: () => loadConfig(),
    loadSessionsHashes: () => readSessionsHashes(),
  };
}
