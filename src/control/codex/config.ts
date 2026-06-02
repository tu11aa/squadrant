// src/control/codex/config.ts
// Read the user's codex config (~/.codex/config.toml or $CODEX_HOME/config.toml)
// and resolve the active model, applying [notice.model_migrations] so cockpit
// uses the same model the TUI would use (e.g. gpt-5.3-codex → gpt-5.5).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function resolveCodexModel(): Promise<string | undefined> {
  const home = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const configPath = join(home, "config.toml");

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }

  // Extract top-level `model = "..."` (only before the first section header).
  const topLevel = text.split(/^\[/m)[0] ?? "";
  const modelMatch = topLevel.match(/^model\s*=\s*"([^"]+)"/m);
  if (!modelMatch) return undefined;
  let model = modelMatch[1]!;

  // Apply [notice.model_migrations] — the TUI uses this map to upgrade legacy
  // model names (e.g. gpt-5.3-codex → gpt-5.5) before calling thread/start.
  // Without this, the app-server sends the stale name and ChatGPT OAuth rejects
  // it with a 400: "The 'gpt-5.3-codex' model is not supported".
  // Capture the section body up to the next section header (`^[`) or end of
  // input. JS regex has no `\z`; `(?![\s\S])` is the end-of-input assertion so
  // migrations still resolve when the section is the last one in the file.
  const migSection = text.match(/^\[notice\.model_migrations\]([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (migSection) {
    const migRe = /^"([^"]+)"\s*=\s*"([^"]+)"/mg;
    let m: RegExpExecArray | null;
    while ((m = migRe.exec(migSection[1]!)) !== null) {
      if (m[1] === model) { model = m[2]!; break; }
    }
  }

  return model;
}
