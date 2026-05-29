// src/control/headless/types.ts
export const HEADLESS_ERROR_TAIL = 2000;

export interface HeadlessResult {
  outcome: "done" | "failed";
  /** Always a string: result text, JSON-stringified non-string result, or raw stdout fallback. Becomes resultRef contents. */
  payload?: string;
  sessionId?: string;
  error?: string;
  exitCode?: number;
  parseWarning?: boolean;
}

export interface HeadlessAdapter {
  provider: string;
  buildCommand(task: string, sessionId?: string): string[];
  parseResult(stdout: string, exitCode: number): HeadlessResult;
}
