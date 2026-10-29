// packages/core/src/launch-line.ts
//
// #1090: a launch line is typed into a fresh shell through the pty, whose
// canonical-mode line buffer is 1024 bytes on macOS — a longer line is cut
// there and the agent never starts. A crew line carries cd + env + `claude`
// with --settings/--mcp-config/--plugin-dir/--add-dir paths, so a long state
// root (the default dev root under $TMPDIR) overflows it. Past a safe size the
// line is written to a 0600 file and a short `eval` of that file is typed
// instead: the shell evaluates the identical text (same cd, env, process tree),
// and the file is deleted as it is read so env values never linger on disk.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { stateRoot } from "@squadrant/shared";
import { shellQuote } from "./crew-protocol.js";

/** Inline lines at or under this many bytes are typed as-is (tty limit is 1024 incl. the newline). */
export const MAX_INLINE_LAUNCH_BYTES = 700;

export function boundedLaunchLine(line: string, dir: string = join(stateRoot(), "launch")): string {
  if (Buffer.byteLength(line) <= MAX_INLINE_LAUNCH_BYTES) return line;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomBytes(6).toString("hex")}.sh`);
  writeFileSync(file, `${line}\n`, { mode: 0o600 });
  const q = shellQuote(file);
  return `eval "$(cat ${q} && rm -f ${q})"`;
}
