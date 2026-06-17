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

  // Spawn a long-running process INSIDE the captain workspace's process tree,
  // so any IPC/socket constraints of the runtime (e.g. cmux's parent-lineage
  // check) are satisfied. Returns a PaneRef the caller can inspect/clean up.
  //
  // placement: "background" produces a non-distracting background tab that does
  // not steal focus from the captain (runtime decides how). "visible" produces
  // a normal focused tab for debug ergonomics.
  spawnInjector(opts: {
    captainWorkspace: WorkspaceRef;
    command: string;
    title?: string;
    placement: "background" | "visible";
  }): Promise<PaneRef>;

  // Send text to a specific surface. Unlike `send` (workspace-level) this
  // targets one surface directly. Used by the notify-relay injector to
  // deliver messages to the captain's primary surface. Throws if the surface
  // no longer exists.
  // opts.probe=true runs the #302 buffer-liveness probe: deliver only if no real
  // draft is present (protects a real draft, never materializes a ghost). Without
  // it, any draft defers (#258/#268 deliver-when-empty).
  sendToSurface(surface: PaneRef, text: string, opts?: { probe?: boolean }): Promise<void>;
}
