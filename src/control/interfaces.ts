// src/control/interfaces.ts
// Driver-seam interfaces: the contracts that cockpitd's driver-agnostic core depends on.
// Concrete implementations (CodexInteractiveDriver, OpencodeSseBridge, CmuxEventsBridge,
// DaemonCmux) live in the root package host and implement these structurally.
import type { PaneRef } from "../runtimes/types.js";

/** Interactive agent runtime driver (codex/claude/opencode thread ops). */
export interface AgentDriver {
  dispatch: (rec: any) => Promise<void>;
  reattach: (rec: any) => Promise<void>;
  say: (taskId: string, text: string) => Promise<void>;
  steer: (taskId: string, text: string) => Promise<void>;
  interrupt: (taskId: string) => Promise<void>;
  answer: (taskId: string, payload: unknown) => Promise<void>;
  close: (taskId: string) => Promise<void>;
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

/** DaemonCmux surface subset used by the daemon-direct delivery loop (#332). */
export interface DaemonSurfaceDriver {
  findWorkspaceId?: (name: string) => Promise<string | null>;
  listSurfaces: (wsId: string) => Promise<PaneRef[]>;
  send: (surface: PaneRef, text: string, opts?: { probe?: boolean }) => Promise<void>;
}
