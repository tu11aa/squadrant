import type { SquadrantConfig } from "../config.js";

export type DriftKind = "missing" | "deprecated" | "changed-default" | "invalid";
export type DriftSeverity = "info" | "advisory" | "warn";

export interface DriftItem {
  path: string;
  kind: DriftKind;
  severity: DriftSeverity;
  current?: unknown;
  suggested?: unknown;
  note?: string;
}

export const SAFE_KINDS: DriftKind[] = ["missing", "deprecated"];

const MANAGED_PATHS: string[] = [
  "defaults.maxCrew",
  "defaults.worktreeDir",
  "defaults.teammateMode",
  "defaults.permissions.*",
  "defaults.roles.*",
  "agents.*",
  "workspace",
  "notifier",
  "runtime",
];

const KNOWN_DEPRECATED: Array<{ path: string; when?: (u: SquadrantConfig) => boolean; note: string }> = [
  {
    path: "defaults.models",
    when: (u) => u.defaults?.roles !== undefined,
    note: "superseded by defaults.roles",
  },
];

const KNOWN_DEFAULT_HISTORY: Array<{ path: string; oldDefaults: unknown[] }> = [
  { path: "defaults.roles.crew.model", oldDefaults: ["opus"] },
  { path: "defaults.roles.captain.model", oldDefaults: ["sonnet"] },
];

const KNOWN_DRIVERS = new Set(["claude", "codex", "gemini", "opencode"]);

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

function hasPath(obj: unknown, dotted: string): boolean {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const k of parts) {
    if (!cur || typeof cur !== "object" || !(k in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

function expandManaged(managed: string, def: SquadrantConfig): string[] {
  if (!managed.endsWith(".*")) return [managed];
  const parent = managed.slice(0, -2);
  const node = getPath(def, parent);
  if (!node || typeof node !== "object") return [];
  return Object.keys(node as Record<string, unknown>).map((k) => `${parent}.${k}`);
}

export function detectDrift(user: SquadrantConfig, def: SquadrantConfig): DriftItem[] {
  const items: DriftItem[] = [];

  for (const managed of MANAGED_PATHS) {
    for (const leaf of expandManaged(managed, def)) {
      const inDefault = hasPath(def, leaf);
      if (inDefault && !hasPath(user, leaf)) {
        items.push({ path: leaf, kind: "missing", severity: "info", suggested: getPath(def, leaf) });
      }
    }
  }

  for (const dep of KNOWN_DEPRECATED) {
    if (hasPath(user, dep.path) && (dep.when ? dep.when(user) : true)) {
      items.push({ path: dep.path, kind: "deprecated", severity: "info", current: getPath(user, dep.path), note: dep.note });
    }
  }

  for (const hist of KNOWN_DEFAULT_HISTORY) {
    if (!hasPath(user, hist.path) || !hasPath(def, hist.path)) continue;
    const cur = getPath(user, hist.path);
    const nowDefault = getPath(def, hist.path);
    if (cur !== nowDefault && hist.oldDefaults.includes(cur)) {
      items.push({
        path: hist.path,
        kind: "changed-default",
        severity: "advisory",
        current: cur,
        suggested: nowDefault,
        note: `default changed from ${JSON.stringify(cur)} to ${JSON.stringify(nowDefault)}`,
      });
    }
  }

  const agents = (user.agents ?? {}) as Record<string, { driver?: string }>;
  for (const [name, entry] of Object.entries(agents)) {
    if (entry?.driver && !KNOWN_DRIVERS.has(entry.driver)) {
      items.push({
        path: `agents.${name}.driver`,
        kind: "invalid",
        severity: "warn",
        current: entry.driver,
        note: `unknown driver '${entry.driver}'; known: ${[...KNOWN_DRIVERS].join(", ")}`,
      });
    }
  }
  const roles = (user.defaults?.roles ?? {}) as Record<string, { agent?: string }>;
  for (const [role, asn] of Object.entries(roles)) {
    if (asn?.agent && !(asn.agent in agents)) {
      items.push({
        path: `defaults.roles.${role}.agent`,
        kind: "invalid",
        severity: "warn",
        current: asn.agent,
        note: `references agent '${asn.agent}' which is not defined in agents`,
      });
    }
  }

  return items;
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]] as Record<string, unknown> | undefined;
    if (!cur || typeof cur !== "object") return;
  }
  delete cur[parts[parts.length - 1]];
}

export function applySafeFixes(
  user: SquadrantConfig,
  items: DriftItem[],
  _def: SquadrantConfig,
): { config: SquadrantConfig; applied: string[] } {
  const config = JSON.parse(JSON.stringify(user)) as SquadrantConfig;
  const applied: string[] = [];
  const root = config as unknown as Record<string, unknown>;
  for (const item of items) {
    if (!SAFE_KINDS.includes(item.kind)) continue;
    if (item.kind === "missing") setPath(root, item.path, item.suggested);
    else if (item.kind === "deprecated") deletePath(root, item.path);
    applied.push(item.path);
  }
  return { config, applied };
}
