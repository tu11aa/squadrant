// Shared first-turn spill (#730, #864). Kept out of crew-spawn.ts/side-session.ts
// so both spawn paths use the SAME mechanism without importing each other.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #730: first-turn text is delivered by pasting it into the agent's cmux pane,
 * then confirming submit once the input box stops changing (confirmedSendToPane /
 * sendFirstTurnWhenReady in packages/workspaces/src/crew-pane.ts). That "stops
 * changing" check only samples the screen a couple of times a second — a
 * multi-KB paste that briefly stalls mid-render (observed at ~2.5-3 KB in #730,
 * ~400 chars into a 1.4 KB side topic in #864) can look settled before it has
 * fully landed, and Enter then submits a truncated draft. There is no way to
 * positively confirm a large paste arrived intact over that path, so text above
 * this size is spilled to a temp file and a short pointer is sent instead — the
 * same workaround that reliably avoided the corruption in #730's own report.
 */
export const FIRST_TURN_INLINE_MAX_BYTES = 1200;

/**
 * Returns `text` unchanged when it fits inline; otherwise writes it to
 * `<tmpdir>/squadrant-task-<id>.md` and returns a short pointer to that file.
 */
export function spillOversizedFirstTurn(text: string, id: string): string {
  if (Buffer.byteLength(text, "utf8") <= FIRST_TURN_INLINE_MAX_BYTES) return text;
  const spillFile = path.join(os.tmpdir(), `squadrant-task-${id}.md`);
  fs.writeFileSync(spillFile, text, "utf8");
  return `Full task is at ${spillFile} — cat it and follow it exactly.`;
}
