// Per-project layered config override file. Pure, file-backed, no daemon
// knowledge. Resolved as built-in → global config.json → projects/<name>.json.
// See docs/superpowers/specs/2026-06-23-per-project-layered-config-design.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRoutingConfig } from "./config.js";

export type CrewTier = "all" | "alert_only" | "done_only" | "none";

export interface NotifyConfig {
  active: boolean;
  cap: boolean;
  crew: CrewTier;
}

/** Per-project override layer. Every key optional; mirrors the global settings. */
export interface ProjectOverrideConfig {
  telegram?: { notify?: Partial<NotifyConfig> };
  // Reserved future tenants (resolver is already generic; consumers not yet wired):
  effort?: "max" | "balance" | "low";
  models?: Partial<ModelRoutingConfig>;
}

function defaultRoot(): string {
  return path.join(os.homedir(), ".config", "squadrant");
}

export function projectConfigPath(name: string, root = defaultRoot()): string {
  return path.join(root, "projects", `${name}.json`);
}

export function loadProjectOverride(name: string, root = defaultRoot()): ProjectOverrideConfig {
  try {
    return JSON.parse(fs.readFileSync(projectConfigPath(name, root), "utf-8")) as ProjectOverrideConfig;
  } catch {
    return {};
  }
}

/** Deep-merge a generic plain-object tree. Arrays/primitives in `patch` replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

export function saveProjectOverride(name: string, patch: ProjectOverrideConfig, root = defaultRoot()): void {
  const merged = deepMerge(loadProjectOverride(name, root), patch);
  const file = projectConfigPath(name, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
}

export const DEFAULT_NOTIFY: NotifyConfig = { active: false, cap: true, crew: "alert_only" };

const CREW_RANK: Record<CrewTier, number> = { none: 0, done_only: 1, alert_only: 2, all: 3 };
export function crewRank(tier: CrewTier): number {
  return CREW_RANK[tier];
}

export function isQuieter(
  before: NotifyConfig,
  after: NotifyConfig,
): { quieter: boolean; dim: "active" | "cap" | "crew" | null } {
  if (before.active && !after.active) return { quieter: true, dim: "active" };
  if (before.cap && !after.cap) return { quieter: true, dim: "cap" };
  if (crewRank(after.crew) < crewRank(before.crew)) return { quieter: true, dim: "crew" };
  return { quieter: false, dim: null };
}

/** Built-in → global → project, per-key. Does NOT apply live state (bridge's job). */
export function resolveNotify(
  globalNotify: Partial<NotifyConfig> | undefined,
  override: ProjectOverrideConfig,
): NotifyConfig {
  let n: NotifyConfig = { ...DEFAULT_NOTIFY };
  if (globalNotify) n = deepMerge(n, globalNotify);
  if (override.telegram?.notify) n = deepMerge(n, override.telegram.notify);
  return n;
}
