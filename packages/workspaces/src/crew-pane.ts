// Runtime-bound crew-pane helpers — discovery, first-turn delivery, captain
// workspace resolution. Extracted from packages/cli/src/commands/crew.ts so
// they are unit-testable with a mock RuntimeDriver.

import net from "node:net";
import { loadConfig } from "@cockpit/shared";
import type { PaneRef, RuntimeDriver } from "@cockpit/shared";
import { RuntimeRegistry } from "./runtimes/registry.js";
import { createCmuxDriver } from "./runtimes/cmux.js";
import { titleFor, isCrewTitle, isTurnAccepted } from "@cockpit/core";
import type { TurnAcceptanceConfig } from "@cockpit/core";

// Poll-based first-turn delivery timing constants.
const SEND_FIRST_TURN_FLOOR_MS = 1500;
const POLL_INTERVAL_MS = 750;
const SEND_FIRST_TURN_TIMEOUT_MS = 20000;
const POST_SEND_CHECK_MS = 750;

/** Reserve an ephemeral TCP port for a crew's embedded HTTP server. Binds :0,
 *  reads the OS-assigned port, then releases it. A small TOCTOU window exists
 *  between release and the crew binding the port; acceptable for local
 *  single-user spawns. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port assigned"))));
    });
  });
}

export async function listProjectCrews(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
): Promise<PaneRef[]> {
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.filter((s) => s.title && isCrewTitle(project, s.title));
}

export async function findCrew(
  runtime: RuntimeDriver,
  workspaceId: string,
  project: string,
  name: string,
): Promise<PaneRef | null> {
  const want = titleFor(project, name);
  const surfaces = await runtime.listSurfaces(workspaceId);
  return surfaces.find((s) => s.title === want) ?? null;
}

export async function resolveCaptainWorkspace(project: string): Promise<{
  runtime: RuntimeDriver;
  workspaceId: string;
}> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'cockpit projects list'.`);
  }
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'cockpit launch ${project}' first.`,
    );
  }
  return { runtime, workspaceId: captain.id };
}

export async function sendFirstTurnWhenReady(
  runtime: Pick<RuntimeDriver, "readPaneScreen" | "sendToPane">,
  pane: PaneRef,
  task: string,
  preLaunchScreen: string,
  acceptanceConfig?: TurnAcceptanceConfig,
): Promise<void> {
  await new Promise((r) => setTimeout(r, SEND_FIRST_TURN_FLOOR_MS));

  const maxPolls = Math.floor(
    (SEND_FIRST_TURN_TIMEOUT_MS - SEND_FIRST_TURN_FLOOR_MS) / POLL_INTERVAL_MS,
  );
  let previousScreen = "";
  let stable = false;

  for (let i = 0; i < maxPolls && !stable; i++) {
    const screen = (await runtime.readPaneScreen(pane)) ?? "";
    // Ready = the agent prompt is actually up: screen is non-empty, settled
    // (unchanged between two consecutive reads), AND has advanced past the
    // un-entered launch command line. The last condition prevents sending the
    // task onto the shell line before the TUI takes over — which concatenates
    // onto the launch command and triggers a shell parse error (opencode
    // boot-race). A momentarily static launch line is not readiness.
    if (screen.length > 0 && screen === previousScreen && screen !== preLaunchScreen) {
      stable = true;
    } else {
      previousScreen = screen;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Snapshot the screen immediately before sending so the post-send check can
  // tell whether the keystrokes were received. Comparing against the raw task
  // text is unreliable: sendToPane collapses newlines to spaces (#136), so a
  // multi-line task never appears verbatim in the single-line pane render and
  // the check would always re-send a duplicate first turn (#168).
  const preSendScreen = (await runtime.readPaneScreen(pane)) ?? "";
  await runtime.sendToPane(pane, task);

  // Bounded retry loop (#235): after sending, poll the pane for evidence that
  // the TUI actually accepted the turn.
  const retryLimit = acceptanceConfig?.retryLimit ?? 2;
  for (let attempt = 0; attempt < retryLimit; attempt++) {
    await new Promise((r) => setTimeout(r, POST_SEND_CHECK_MS));
    const afterScreen = (await runtime.readPaneScreen(pane)) ?? "";
    if (isTurnAccepted(preSendScreen, afterScreen, acceptanceConfig)) {
      return;
    }
    if (attempt < retryLimit - 1) {
      await runtime.sendToPane(pane, task);
    }
  }
}
