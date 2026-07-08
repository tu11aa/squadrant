// src/control/interfaces.ts
// Driver-seam interfaces: the contracts that squadrantd's driver-agnostic core depends on.
// Concrete implementations (CodexInteractiveDriver, OpencodeSseBridge, CmuxEventsBridge,
// DaemonCmux) live in the root package host and implement these structurally.
import type { PaneRef, RuntimeLivenessRecord } from "@squadrant/shared";

/** Interactive agent runtime driver (codex/claude/opencode thread ops). */
export interface AgentDriver {
  dispatch: (rec: any) => Promise<void>;
  reattach: (rec: any) => Promise<void>;
  say: (taskId: string, text: string) => Promise<void>;
  steer: (taskId: string, text: string) => Promise<void>;
  interrupt: (taskId: string) => Promise<void>;
  answer: (taskId: string, payload: unknown) => Promise<void>;
  close: (taskId: string) => Promise<void>;
  /** Tear down any long-lived child process (e.g. codex app-server) on daemon stop. */
  stop?: () => void;
}

/** Opencode SSE bridge seam (start/stop per-crew subscription + approve/deny). */
export interface OpencodeBridge {
  start: (o: { taskId: string; port: number }) => void;
  stop: (taskId: string) => void;
  /** CP3: POST the captain's approve/deny decision to the crew's server. */
  answer: (taskId: string, decision: "approve" | "deny") => Promise<boolean>;
}

/** cmux native-events subscription seam (single global start/stop). */
export interface CmuxEventsBridge {
  start: () => void;
  stop: () => void;
}

/** DaemonCmux read-only subset used by direct crew-pane probes. */
export interface DirectCmuxReader {
  findWorkspaceId(name: string): Promise<string | null>;
  listSurfaces(wsId: string): Promise<PaneRef[]>;
  readPaneScreen(pane: PaneRef): Promise<string | null>;
}

/** Full DaemonCmux seam: send (delivery loop) + read (pane probes). DaemonCmux in root implements this. */
export interface DaemonSurfaceDriver extends DirectCmuxReader {
  findWorkspaceId(name: string): Promise<string | null>;
  listSurfaces(wsId: string): Promise<PaneRef[]>;
  send: (surface: PaneRef, text: string, opts?: { probe?: boolean }) => Promise<void>;
  readPaneScreen(pane: PaneRef): Promise<string | null>;
  /** Ground-truth liveness from the runtime's own session store (§5.4).
   *  Optional — a runtime with no such store omits it. */
  liveness?(): Promise<RuntimeLivenessRecord[]>;
}
