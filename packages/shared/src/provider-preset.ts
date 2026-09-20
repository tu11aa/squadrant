// packages/shared/src/provider-preset.ts
// #826: provider-preset chooser for `squadrant init`. A fresh install used to
// assume an Anthropic credential (roles = all claude, permissions = auto). For
// a user without one that fails closed on first run: Claude Code's auto-mode
// classifier is hardcoded to Claude Sonnet 5, which a router upstream does not
// serve. A preset writes the roles / permissions / router / gate blocks that
// match the provider the operator actually has.
//
// Two rules govern the merge:
//   - Fresh config (or an explicit `--preset`) => overwrite the preset-owned
//     blocks.
//   - Existing config re-run => fill ONLY a wholly-absent block. Never clobber
//     roles/permissions/router/gate an operator already has, and never touch an
//     unrelated section (effort, projects, telegram, …).

import type {
  GateConfig,
  PermissionConfig,
  RoleConfig,
  RouterConfig,
  SquadrantConfig,
} from "./config.js";

export type ProviderPresetId = "a" | "b" | "c" | "d";

export interface ProviderPresetInfo {
  id: ProviderPresetId;
  label: string;
  summary: string;
  /** A preset that needs a real Anthropic credential (Pro/Max or API key). */
  requiresAnthropic: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPresetInfo[] = [
  {
    id: "a",
    label: "Claude Code (Pro/Max)",
    summary: "Claude harness on your subscription/API key. Real auto mode.",
    requiresAnthropic: true,
  },
  {
    id: "b",
    label: "opencode (no Anthropic subscription)",
    summary: "All roles run on the opencode harness. Auto mode is model-agnostic.",
    requiresAnthropic: false,
  },
  {
    id: "c",
    label: "Claude harness + router backend (advanced)",
    summary: "Claude harness against a router upstream. The U7 gate replaces auto mode.",
    requiresAnthropic: false,
  },
  {
    id: "d",
    label: "Codex (ChatGPT Pro)",
    summary: "All roles run on the codex harness.",
    requiresAnthropic: false,
  },
];

export function isProviderPresetId(v: string): v is ProviderPresetId {
  return v === "a" || v === "b" || v === "c" || v === "d";
}

/** Literal model the documented opencode-go upstream serves. A routed claude
 *  role uses this until the operator points it at another upstream/model. */
export const ROUTER_PRESET_MODEL = "deepseek-v4.1-flash";

/** The upstream opencode itself talks to by default (docs/specs/...-router-config-u2). */
export const DEFAULT_ROUTER_KIND = "opencode-go" as const;
export const DEFAULT_ROUTER_BASE_URL = "https://opencode.ai/zen/go";

export interface ProviderPresetDefaults {
  roles: RoleConfig;
  /** Partial — preset D (codex) leaves claude's permission modes alone. */
  permissions: Partial<PermissionConfig>;
  router?: RouterConfig;
  gate?: GateConfig;
}

/** The exact config blocks a preset wants to write. Pure. Throws for preset C
 *  without a router config (a routed role with no upstream is a hard error). */
export function providerPresetDefaults(
  id: ProviderPresetId,
  router?: RouterConfig,
): ProviderPresetDefaults {
  switch (id) {
    case "a":
      return {
        roles: {
          command: { agent: "claude", model: "opus" },
          captain: { agent: "claude", model: "opus" },
          crew: { agent: "claude", model: "sonnet" },
          exploration: { agent: "claude", model: "haiku" },
          side: { agent: "claude", model: "opus" },
        },
        permissions: { command: "auto", captain: "auto", crew: "auto" },
      };
    case "b": {
      const opencode = { agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" };
      return {
        roles: {
          command: { ...opencode },
          captain: { ...opencode },
          crew: { ...opencode },
          exploration: { ...opencode },
          side: { ...opencode },
        },
        permissions: { command: "auto", captain: "auto", crew: "auto" },
      };
    }
    case "c": {
      if (!router) {
        throw new Error(
          "preset C (claude harness + router backend) requires a router config — set defaults.router first",
        );
      }
      const routed = { agent: "claude", backend: "proxy" as const, model: ROUTER_PRESET_MODEL };
      return {
        roles: {
          command: { ...routed },
          captain: { ...routed },
          crew: { ...routed },
          exploration: { ...routed },
          side: { ...routed },
        },
        // Auto mode's classifier is hardcoded to Sonnet 5 and fails closed on a
        // router upstream — every claude session must use a manual mode so the
        // U7 gate owns the prompt.
        permissions: { command: "default", captain: "default", crew: "default" },
        router,
        gate: { mode: "on" },
      };
    }
    case "d": {
      const codex = { agent: "codex" };
      return {
        roles: {
          command: { ...codex },
          captain: { ...codex },
          crew: { ...codex },
          exploration: { ...codex },
          side: { ...codex },
        },
        permissions: {},
      };
    }
  }
}

/** Infer which preset a config currently reflects, from its crew role. Lets a
 *  re-run default the provider question to the operator's current setup. */
export function detectProviderPresetId(config: SquadrantConfig): ProviderPresetId {
  const crew = config.defaults?.roles?.crew;
  if (crew?.agent === "opencode") return "b";
  if (crew?.agent === "codex") return "d";
  if (crew?.backend && crew.backend !== "native") return "c";
  return "a";
}

export interface ApplyProviderPresetOptions {
  router?: RouterConfig;
  /** true => the preset's roles/permissions replace existing ones (fresh config
   *  or an explicit `--preset`). false => fill only wholly-absent blocks. */
  overwrite: boolean;
}

export interface ApplyProviderPresetResult {
  config: SquadrantConfig;
  /** Human-readable dotted paths that changed (empty ⇒ nothing to write). */
  changes: string[];
}

/**
 * Apply a provider preset to a config, returning a NEW config (deep-cloned —
 * the input is never mutated). Re-run-safe for unrelated sections.
 */
export function applyProviderPreset(
  config: SquadrantConfig,
  id: ProviderPresetId,
  opts: ApplyProviderPresetOptions,
): ApplyProviderPresetResult {
  const preset = providerPresetDefaults(id, opts.router);
  const next = structuredClone(config);
  const changes: string[] = [];

  // roles — block-level: replace when overwriting, fill only when absent.
  if (opts.overwrite) {
    next.defaults.roles = { ...preset.roles };
    changes.push("defaults.roles");
  } else if (next.defaults.roles === undefined) {
    next.defaults.roles = { ...preset.roles };
    changes.push("defaults.roles");
  }

  // permissions — partial merge; present keys are never clobbered on a re-run.
  const existingPerms = next.defaults.permissions ?? {};
  if (opts.overwrite) {
    next.defaults.permissions = { ...existingPerms, ...preset.permissions };
    if (Object.keys(preset.permissions).length > 0) changes.push("defaults.permissions");
  } else if (next.defaults.permissions === undefined && Object.keys(preset.permissions).length > 0) {
    next.defaults.permissions = { ...preset.permissions } as PermissionConfig;
    changes.push("defaults.permissions");
  }

  // router — only preset C sets it; never removed for A/B/D.
  if (preset.router) {
    if (opts.overwrite || next.defaults.router === undefined) {
      next.defaults.router = structuredClone(preset.router);
      changes.push("defaults.router");
    }
  }

  // gate — only preset C sets it; never removed for A/B/D.
  if (preset.gate) {
    if (opts.overwrite || next.defaults.gate === undefined) {
      next.defaults.gate = { ...preset.gate };
      changes.push("defaults.gate");
    }
  }

  return { config: next, changes };
}
