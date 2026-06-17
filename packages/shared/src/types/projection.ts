export interface ProjectionSource {
  instructions: string;
  skills: Array<{ name: string; description: string; content: string }>;
}

export interface ProjectionDestination {
  path: string;
  shared: boolean;
  format: "markdown" | "mdc";
}

export interface ProjectionEmitResult {
  written: boolean;
  path: string;
  bytesWritten: number;
  diff?: string;
}

export interface ProjectionEmitter {
  name: string;
  destinations(scope: "user" | "project", projectRoot?: string): ProjectionDestination[];
  emit(
    source: ProjectionSource,
    dest: ProjectionDestination,
    opts?: { dryRun?: boolean },
  ): Promise<ProjectionEmitResult>;
}

export type ProjectionEmitterFactory = () => ProjectionEmitter;
