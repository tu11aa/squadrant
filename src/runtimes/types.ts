export interface WorkspaceRef {
  id: string;       // runtime-native ref (cmux: "workspace:42")
  name: string;     // human name ("brove-captain")
  status: "running" | "stopped" | "unknown";
}

export interface PaneRef {
  workspaceId: string; // parent workspace ref ("workspace:42")
  surfaceId: string;   // runtime-native surface ref (cmux: "surface:7")
  title?: string;      // tab title — populated by listSurfaces, optional on spawn
}

export interface RuntimeSpawnOptions {
  name: string;
  workdir: string;
  command: string;  // the full agent CLI invocation
  icon?: string;
  pinToTop?: boolean;
}

// "tab" creates a new top-level surface (cmux: new-surface) inside the
// workspace; the cardinal directions split the current surface into a pane
// (cmux: new-pane). Both produce a PaneRef with a fresh surfaceId.
export type PanePlacement = "tab" | "right" | "left" | "up" | "down";

export interface RuntimePaneOptions {
  workspaceId: string;
  direction: PanePlacement;
  title?: string;
}

export interface RuntimeProbeResult {
  installed: boolean;
  version: string;
}

export interface RuntimeDriver {
  name: string;                                        // "cmux", "tmux", ...

  probe(): Promise<RuntimeProbeResult>;
  list(): Promise<WorkspaceRef[]>;
  status(nameOrId: string): Promise<WorkspaceRef | null>;
  spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef>;
  send(ref: string, message: string): Promise<void>;   // delivers AND commits (Enter)
  sendKey(ref: string, key: string): Promise<void>;    // literal key press
  readScreen(ref: string): Promise<string>;
  stop(ref: string): Promise<void>;

  // Pane operations — used for crew split-pane spawn (#41)
  newPane(opts: RuntimePaneOptions): Promise<PaneRef>;
  closePane(pane: PaneRef): Promise<void>;
  sendToPane(pane: PaneRef, message: string): Promise<void>; // sends text + Enter
  readPaneScreen(pane: PaneRef): Promise<string>;
  // List all surfaces (tabs/panes) inside a workspace, with their titles.
  // Used to find named crews by tab title (#56).
  listSurfaces(workspaceId: string): Promise<PaneRef[]>;
}
