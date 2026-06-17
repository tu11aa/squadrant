export interface WorkspaceProbeResult {
  installed: boolean;
  rootExists: boolean;
}

export interface WorkspaceScope {
  root?: string;
  [key: string]: unknown;
}

export interface WorkspaceDriver {
  name: string;

  probe(): Promise<WorkspaceProbeResult>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
}

export type WorkspaceFactory = (scope: WorkspaceScope) => WorkspaceDriver;
