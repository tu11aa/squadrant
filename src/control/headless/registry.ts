// src/control/headless/registry.ts
import type { HeadlessAdapter } from "./types.js";
import { claudeHeadless } from "./claude.js";
import { opencodeHeadless } from "./opencode.js";
import { codexHeadless } from "./codex.js";

const ADAPTERS: Record<string, HeadlessAdapter> = {
  claude: claudeHeadless,
  opencode: opencodeHeadless,
  codex: codexHeadless,
};

export function getHeadlessAdapter(provider: string): HeadlessAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`no headless adapter for provider '${provider}'`);
  return a;
}
