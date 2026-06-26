// Runtime-bound crew-pane helpers — discovery, first-turn delivery, captain
// workspace resolution. Extracted from packages/cli/src/commands/crew.ts so
// they are unit-testable with a mock RuntimeDriver.

import net from "node:net";
import { loadConfig } from "@squadrant/shared";
import type { PaneRef, RuntimeDriver } from "@squadrant/shared";
import { RuntimeRegistry } from "./runtimes/registry.js";
import { createCmuxDriver, parseDraftFromScreen } from "./runtimes/cmux.js";
import { titleFor, isCrewTitle, isTurnAccepted } from "@squadrant/core";
import type { TurnAcceptanceConfig } from "@squadrant/core";

// Poll-based first-turn delivery timing constants.
const SEND_FIRST_TURN_FLOOR_MS = 1500;
const POLL_INTERVAL_MS = 750;
const SEND_FIRST_TURN_TIMEOUT_MS = 20000;
const POST_SEND_CHECK_MS = 750;

// #235 Confirm-on-delivery constants for splash-gated agents (opencode).
// We poll every POST_SEND_CHECK_MS but only re-send every SPLASH_RESEND_EVERY_N
// checks — a 3s de-dup guard that prevents double-execution when the TUI is
// slow to redraw after accepting.
const SPLASH_MAX_CHECKS = 20;    // 20 × 750ms ≈ 15s confirmation window
const SPLASH_RESEND_EVERY_N = 4; // re-send every 4 checks ≈ every 3s

// #339 paste-then-submit constants for the claude/codex first-turn path.
// SETTLE polls the input box after the paste until its content stops changing —
// i.e. Claude Code's paste-accumulation window has closed — so the submit CR is a
// separate keystroke that lands AFTER the [Pasted text] placeholder is final and
// is therefore treated as a submit, not a literal newline inside the paste.
const SETTLE_POLL_MS = 400;
const SETTLE_MAX_POLLS = 8;        // up to 3.2s for a very large paste to render
const SUBMIT_RETRY_LIMIT = 4;      // Enter-only re-issues if the box stays stranded

/** Poll the pane until its input box stops changing across two consecutive reads
 *  (paste fully rendered / accumulation window closed), or the cap is hit. */
async function settleInputBox(
  runtime: Pick<RuntimeDriver, "readPaneScreen">,
  pane: PaneRef,
): Promise<void> {
  let prev = (await runtime.readPaneScreen(pane)) ?? "";
  for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    const cur = (await runtime.readPaneScreen(pane)) ?? "";
    if (cur === prev) return;
    prev = cur;
  }
}

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
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
  const captain = await runtime.status(proj.captainName);
  if (!captain) {
    throw new Error(
      `Captain workspace '${proj.captainName}' is not running. Run 'squadrant launch ${project}' first.`,
    );
  }
  return { runtime, workspaceId: captain.id };
}

/**
 * Deliver a message to a crew pane with the paste-settle-Enter confirmation
 * sequence from #447. Shared by the follow-up `crew send` path (#448) and
 * available for first-turn use — both call the same submit hardening:
 *   1. paste only (no bundled CR)
 *   2. settle until the input box content stops changing (accumulation closed)
 *   3. separate Enter keystroke
 *   4. confirm box empty; re-issue ONLY Enter if stranded (never re-paste)
 */
export async function confirmedSendToPane(
  runtime: Pick<RuntimeDriver, "readPaneScreen" | "pasteToPane" | "sendKeyToPane">,
  pane: PaneRef,
  message: string,
): Promise<void> {
  const preSendScreen = (await runtime.readPaneScreen(pane)) ?? "";
  await runtime.pasteToPane(pane, message);
  await settleInputBox(runtime, pane);
  await runtime.sendKeyToPane(pane, "Enter");

  for (let attempt = 0; attempt < SUBMIT_RETRY_LIMIT; attempt++) {
    await new Promise((r) => setTimeout(r, POST_SEND_CHECK_MS));
    const afterScreen = (await runtime.readPaneScreen(pane)) ?? "";
    const draft = parseDraftFromScreen(afterScreen);
    if (draft === "") return;
    if (draft === null && afterScreen !== preSendScreen) return;
    await settleInputBox(runtime, pane);
    await runtime.sendKeyToPane(pane, "Enter");
  }
}

export async function sendFirstTurnWhenReady(
  runtime: Pick<RuntimeDriver, "readPaneScreen" | "sendToPane" | "pasteToPane" | "sendKeyToPane">,
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

  // Confirm-on-delivery (#235): poll until the TUI confirms it accepted the turn.
  if (acceptanceConfig?.splashMarker) {
    // Splash path (opencode): the "Ask anything…" splash clears once the TUI
    // consumes the message. We check every POST_SEND_CHECK_MS but re-send only
    // every SPLASH_RESEND_EVERY_N checks — a 3s de-dup guard that prevents
    // duplicate task execution when the TUI is slow to redraw after accepting.
    // opencode's TUI does not collapse pastes into placeholders, so the atomic
    // send+Enter (sendToPane) is correct here and must stay (it was just fixed
    // and live-verified in #235). The #339 paste race is claude-specific.
    await runtime.sendToPane(pane, task);
    for (let check = 0; check < SPLASH_MAX_CHECKS; check++) {
      await new Promise((r) => setTimeout(r, POST_SEND_CHECK_MS));
      const afterScreen = (await runtime.readPaneScreen(pane)) ?? "";
      if (isTurnAccepted(preSendScreen, afterScreen, acceptanceConfig)) {
        return;
      }
      if ((check + 1) % SPLASH_RESEND_EVERY_N === 0 && check < SPLASH_MAX_CHECKS - 1) {
        await runtime.sendToPane(pane, task);
      }
    }
    return;
  }

  // Claude/codex path (#339): paste the task, let the [Pasted text] placeholder
  // settle, THEN submit with a separate Enter. Bundling the CR with the paste
  // (the old sendToPane) lets Claude Code absorb it as a literal newline inside
  // the placeholder under load, stranding the whole turn unsubmitted. We confirm
  // the submit by the input box going empty — NOT by "screen changed", because
  // the paste itself changes the screen. If the box is still holding the draft we
  // re-issue ONLY the Enter (after re-settling) and NEVER re-paste — re-pasting is
  // exactly what stacks [Pasted text #1][#2][#3] and never submits.
  await runtime.pasteToPane(pane, task);
  await settleInputBox(runtime, pane);
  await runtime.sendKeyToPane(pane, "Enter");

  const retryLimit = acceptanceConfig?.retryLimit ?? SUBMIT_RETRY_LIMIT;
  for (let attempt = 0; attempt < retryLimit; attempt++) {
    await new Promise((r) => setTimeout(r, POST_SEND_CHECK_MS));
    const afterScreen = (await runtime.readPaneScreen(pane)) ?? "";
    const draft = parseDraftFromScreen(afterScreen);
    // Box confirmed empty → the draft left the input box → submitted.
    if (draft === "") return;
    // Box not parseable (e.g. an agent TUI without the HR-bounded box, or a
    // transient overlay): fall back to the screen-changed signal so non-claude
    // TUIs aren't worse off than before.
    if (draft === null && afterScreen !== preSendScreen) return;
    // Still stranded — re-settle and re-issue ONLY the Enter (never re-paste).
    await settleInputBox(runtime, pane);
    await runtime.sendKeyToPane(pane, "Enter");
  }
}
