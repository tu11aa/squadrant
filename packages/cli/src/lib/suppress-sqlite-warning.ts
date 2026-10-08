// Node prints "ExperimentalWarning: SQLite is an experimental feature" on every command that loads
// node:sqlite. Drop only that warning; everything else still reaches Node's default handler.
// Imported first by the CLI and daemon entry points so it is installed before node:sqlite loads.
export function isSqliteExperimentalWarning(warning: unknown, type?: unknown): boolean {
  const name = typeof warning === "object" && warning !== null ? (warning as Error).name : typeof type === "string" ? type : undefined;
  const message = typeof warning === "string" ? warning : (warning as Error | undefined)?.message;
  return name === "ExperimentalWarning" && typeof message === "string" && /SQLite is an experimental feature/i.test(message);
}

const original = process.emitWarning.bind(process) as (...a: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const first = rest[0];
  const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
  if (isSqliteExperimentalWarning(warning, type)) return;
  original(warning, ...rest);
}) as typeof process.emitWarning;
