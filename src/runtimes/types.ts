export interface WorkspaceRef {
  id: string;       // runtime-native ref (cmux: "workspace:42")
  name: string;     // human name ("brove-captain")
  status: "running" | "stopped" | "unknown";
}

export interface PaneRef {
  workspaceId: string; // parent workspace ref ("workspace:42")
  surfaceId: string;   // runtime-native surface ref (cmux: "surface:7")
}

export interface RuntimeSpawnOptions {
  name: string;
  workdir: string;
  command: string;  // the full agent CLI invocation
  icon?: string;
  pinToTop?: boolean;
}

export interface RuntimePaneOptions {
  workspaceId: string;
  direction: "right" | "left" | "up" | "down";
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
}
