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
  workspacePath,
  stateRoot,
} from "@squadrant/shared";
import { shellQuote } from "./crew-protocol.js";
import { boundedLaunchLine } from "./launch-line.js";
import { SIDE_SESSION_ENV } from "./permission-gate.js";
import { spillOversizedFirstTurn } from "./first-turn-spill.js";
import { frameMessage, frameFirstTurn } from "./squadrant-message.js";
import { sideStateDir, writeSideInitPrompt } from "./first-turn-init.js";

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
 *  for handoff (workspace dir, project, role). For debug sessions, scratchWorktree
 *  is the isolated worktree path the session is running in. */
export function buildSideFirstTurn(
  topic: string,
  project: string,
  role: string,
  workspace: string,
  scratchWorktree?: string,
  name?: string,
): string {
  const lines = [
    topic,
    "",
    "---",
    "Side-session context (for handoff use):",
    `Project: ${project}`,
    `Role: ${role}`,
    `Workspace: ${workspace}`,
  ];
  if (name) lines.push(`Side name: ${name}`);
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
  agentCmdFactory: (spawnCwd: string, init?: { initPromptFile: string }) => string;
  /** CLI-edge: deliver the first turn when the agent pane is ready. */
  sendFirstTurn: (pane: PaneRef, firstTurn: string, preLaunchScreen: string) => Promise<{ delivered: boolean }>;
  /**
   * CLI-edge, set only for agents that take a launch-time init prompt (claude).
   * When present, the first turn is written to init.md and passed as the launch
   * positional; this watcher answers the folder-trust panel until the agent is
   * up. `booted: false` (or an init.md that cannot be written) falls back to
   * `sendFirstTurn` — the pane path.
   */
  watchBoot?: (pane: PaneRef) => Promise<{ booted: boolean }>;
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

  const firstTurn = buildSideFirstTurn(
    input.topic,
    input.project,
    input.role,
    workspacePath(input.project),
    input.role === "debug" ? spawnCwd : undefined,
    name,
  );
  const framedFirstTurn = frameFirstTurn(firstTurn, { project: input.project, kind: "side.open" });
  // Launch-time init prompt (claude): a real user turn, no paste. The whole topic
  // goes in the file; a launch arg has no size limit, so no spill either.
  let initPath: string | undefined;
  if (deps.watchBoot) {
    try {
      initPath = writeSideInitPrompt({ stateRoot: stateRoot(), project: input.project, name, text: framedFirstTurn }).initPath;
    } catch (e) {
      process.stderr.write(`(side init prompt not written, falling back to a first-turn send: ${(e as Error).message})\n`);
    }
  }
  const agentCmd = deps.agentCmdFactory(spawnCwd, initPath ? { initPromptFile: initPath } : undefined);

  const direction: PanePlacement = input.direction ?? "tab";
  const title = sideTitleFor(input.project, name);
  const pane = await runtime.newPane({ workspaceId: captain.id, direction, title });

  // #782: mark the tab so the permission gate (commands/gate.ts) can identify a
  // squadrant side session without a crew task id. Harmless for non-claude agents.
  await runtime.sendToPane(pane, boundedLaunchLine(`cd ${shellQuote(spawnCwd)} && ${SIDE_SESSION_ENV}=1 ${agentCmd}`));
  const preLaunchScreen = (await runtime.readPaneScreen(pane)) ?? "";

  // No task record and no crew lifecycle here, so nothing confirms delivery; the
  // boot watcher is the only signal that the queued init prompt is being submitted.
  const booted = initPath && deps.watchBoot
    ? await deps.watchBoot(pane).then((b) => b.booted, () => false)
    : false;
  if (!booted) {
    // #864: same spill as the crew path (#730) — a long multi-line topic pasted
    // into the pane gets truncated mid-render; send a pointer to a temp file instead.
    await deps.sendFirstTurn(pane, frameFirstTurn(spillOversizedFirstTurn(firstTurn, `side-${input.project}-${name}`), { project: input.project, kind: "side.open" }), preLaunchScreen);
  }

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
  await runtime.sendToPane(pane, frameMessage({ from: `captain:${project}`, project, kind: "side.send" }, message));
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
  // closePane force-closes the surface, which tears down the agent's pty (#895).
  try {
    await runtime.closePane(pane);
  } catch (e) {
    process.stderr.write(`(pane close failed: ${(e as Error).message})\n`);
  }
  // The per-side init.md holds the topic; drop it with the session (best-effort).
  fs.rmSync(sideStateDir(stateRoot(), project, name), { recursive: true, force: true });
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
