// Side-session orchestration — driver-agnostic algorithm (#367 command-thinning).
// CLI-edge concerns (concrete driver construction, agent command building,
// sendFirstTurnWhenReady) are injected as closures; core only imports from
// @squadrant/shared (and node built-ins).

import fs from "node:fs";
import {
  loadConfig,
  type SquadrantConfig,
  type PaneRef,
  type PanePlacement,
  type RuntimeDriver,
  addWorktree,
  removeWorktree,
  worktreePath,
  resolveWorktreeBase,
} from "@squadrant/shared";
import { shellQuote } from "./crew-protocol.js";

// ─── naming primitives ────────────────────────────────────────────────────────
// These parallel the crew naming helpers in crew-protocol.ts but use the 🗒
// prefix. Prefixed with "side" to avoid barrel-level name conflicts.

export function sideTitleFor(project: string, name: string): string {
  return `🗒 ${project}:${name}`;
}

export function isSideTitle(project: string, title: string): boolean {
  return title.startsWith(`🗒 ${project}:`);
}

export function sideNameFromTitle(project: string, title: string): string {
  return title.slice(`🗒 ${project}:`.length);
}

export function sideNextAutoName(existingTitles: string[], project: string): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const n = sideNameFromTitle(project, title).match(/^side-(\d+)$/);
    if (n) used.add(Number(n[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `side-${i}`;
}

// ─── first-turn builder ───────────────────────────────────────────────────────

/** Builds the first-turn message: topic + injected context the agent needs
 *  for handoff (spokeVault, project, role). For debug sessions, scratchWorktree
 *  is the isolated worktree path the session is running in. */
export function buildSideFirstTurn(
  topic: string,
  project: string,
  role: string,
  spokeVault: string,
  scratchWorktree?: string,
): string {
  const lines = [
    topic,
    "",
    "---",
    "Side-session context (for handoff use):",
    `Project: ${project}`,
    `Role: ${role}`,
    `Spoke vault: ${spokeVault}`,
  ];
  if (scratchWorktree) {
    lines.push(`Scratch worktree: ${scratchWorktree}`);
  }
  return lines.join("\n");
}

// ─── spawn orchestration ──────────────────────────────────────────────────────

const SIDE_ROLES = ["research", "debug"] as const;
type SideRole = (typeof SIDE_ROLES)[number];

export interface SideSpawnInput {
  project: string;
  topic: string;
  role: string;
  name?: string;
  direction?: PanePlacement;
  agent?: string; // passed through to CLI — not used by core
}

export interface SideSpawnDeps {
  runtime: RuntimeDriver;
  /**
   * CLI-edge factory: called with the resolved spawn CWD (proj.path for research,
   * scratch worktree path for debug) so @squadrant/agents can set workdir correctly.
   */
  agentCmdFactory: (spawnCwd: string) => string;
  /** CLI-edge: deliver the first turn when the agent pane is ready. */
  sendFirstTurn: (pane: PaneRef, firstTurn: string, preLaunchScreen: string) => Promise<{ delivered: boolean }>;
}

export async function runSideSpawn(
  input: SideSpawnInput,
  config: SquadrantConfig,
  deps: SideSpawnDeps,
): Promise<PaneRef> {
  const proj = config.projects[input.project];
  if (!proj) {
    throw new Error(`Project '${input.project}' not found. Run 'squadrant projects list'.`);
  }

  if (!SIDE_ROLES.includes(input.role as SideRole)) {
    throw new Error(
      `Unknown side role '${input.role}'. Valid roles: ${SIDE_ROLES.join(", ")}.`,
    );
  }

  const { runtime } = deps;

  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'squadrant launch ${input.project}' first.`,
    );
  }

  const existing = await runtime.listSurfaces(captain.id);
  const existingTitles = existing
    .filter((s) => s.title && isSideTitle(input.project, s.title))
    .map((s) => s.title!);

  if (input.name) {
    const wantTitle = sideTitleFor(input.project, input.name);
    if (existingTitles.includes(wantTitle)) {
      throw new Error(
        `Side session '${input.name}' already exists for ${input.project}.`,
      );
    }
  }
  const name = input.name ?? sideNextAutoName(existingTitles, input.project);

  // Debug sessions run in an isolated scratch git worktree so instrumentation
  // edits never touch the captain's checkout. Research sessions share the root
  // checkout. The #279 fix (cd into spawnCwd before launching CLI) applies to both.
  const spawnCwd = input.role === "debug"
    ? addWorktree({
        repoRoot: proj.path,
        worktreeDir: config.defaults.worktreeDir ?? ".worktrees",
        project: input.project,
        name,
        base: resolveWorktreeBase(proj.path),
      })
    : proj.path;

  const agentCmd = deps.agentCmdFactory(spawnCwd);

  const direction: PanePlacement = input.direction ?? "tab";
  const title = sideTitleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  await runtime.sendToPane(pane, `cd ${shellQuote(spawnCwd)} && ${agentCmd}`);
  const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";

  const firstTurn = buildSideFirstTurn(
    input.topic,
    input.project,
    input.role,
    proj.spokeVault ?? "",
    input.role === "debug" ? spawnCwd : undefined,
  );
  await deps.sendFirstTurn(pane, firstTurn, preLaunchScreen);

  return { ...pane, title };
}

// ─── send / list / close ─────────────────────────────────────────────────────

export async function runSideSend(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
  name: string,
  message: string,
): Promise<void> {
  const want = sideTitleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'squadrant side list ${project}'.`,
    );
  }
  await runtime.sendToPane(pane, message);
}

export async function runSideList(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
): Promise<Array<{ name: string; surfaceId: string }>> {
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces
    .filter((s) => s.title && isSideTitle(project, s.title))
    .map((s) => ({
      name: sideNameFromTitle(project, s.title!),
      surfaceId: s.surfaceId,
    }));
}

export async function runSideClose(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
  name: string,
  projPath: string | undefined,
  worktreeDir: string,
): Promise<void> {
  const want = sideTitleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  const pane = surfaces.find((s) => s.title === want) ?? null;
  if (!pane) {
    throw new Error(
      `Side session '${name}' not found for ${project}. Run 'squadrant side list ${project}'.`,
    );
  }
  await runtime.closePane(pane);
  // Prune the scratch worktree if this was a debug session. Detection is
  // filesystem-based: debug spawns create a worktree at the deterministic path;
  // research spawns do not. If the path exists, remove it (best-effort).
  if (projPath) {
    const wtPath = worktreePath(projPath, worktreeDir, project, name);
    if (fs.existsSync(wtPath)) {
      try {
        removeWorktree(projPath, wtPath);
      } catch (e) {
        process.stderr.write(`(worktree remove failed: ${(e as Error).message})\n`);
      }
    }
  }
}
