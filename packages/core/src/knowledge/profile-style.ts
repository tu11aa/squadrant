// packages/core/src/knowledge/profile-style.ts — the operator style section as a launch-time add-on (#1129).
// `kind: style` traits are rendered after the role prompt into a file squadrant generates in its OWN config dir, which the
// Claude launch already passes via --append-system-prompt-file. Appended system-prompt text stacks with any /output-style.
// No style traits for the role ⇒ the role file path is returned unchanged (launch args byte-identical). Fail-open.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, loadConfig, userKbDir, type SquadrantConfig } from "@squadrant/shared";
import { loadProfile, styleText, type Trait } from "./profile.js";

export const STYLE_DIR = "styled-prompts";
export const STYLE_ROLES = ["captain", "command", "crew", "side"] as const;

const HEADER = "Operator communication style. This adds to your default style and to any output style the operator selects; it never overrides code, commands or safety rules.";

/** crew sees the crew view; captain, command and side sessions see the captain view. */
const hiddenAudience = (role: string) => (role === "crew" ? "captain" : "crew");

/** Active style traits that apply to `role`, in id order. */
export function styleTraitsFor(root: string, role: string): Trait[] {
  const hidden = hiddenAudience(role);
  return loadProfile(root).active
    .filter((t) => t.kind === "style" && t.audience !== hidden)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function renderStyleBlock(traits: Trait[]): string {
  return ["<squadrant-operator-style>", HEADER, ...traits.map(styleText), "</squadrant-operator-style>", ""].join("\n");
}

/** What a role got: the trait ids and rendered size (for doctor / config check). */
export function styleSummary(root: string, role: string): { ids: string[]; chars: number } {
  const traits = styleTraitsFor(root, role);
  return { ids: traits.map((t) => t.id), chars: traits.length ? renderStyleBlock(traits).length : 0 };
}

export interface StyleRow { role: string; agent: string; ids: string[]; chars: number; delivered: boolean }

/** Per role: which style it gets and whether its agent receives it (phase 1: claude only). For doctor and `profile list`. */
export function styleReport(cfg: SquadrantConfig, env: NodeJS.ProcessEnv = process.env): StyleRow[] {
  const root = userKbDir(cfg, env);
  return STYLE_ROLES.map((role) => {
    const agent = cfg.defaults?.roles?.[role as "captain"]?.agent ?? "claude";
    const s = styleSummary(root, role);
    return { role, agent, ...s, delivered: s.ids.length > 0 && agent === "claude" };
  });
}

export function formatStyleRow(r: StyleRow): string {
  if (!r.ids.length) return `${r.role} (${r.agent}): no style`;
  return `${r.role} (${r.agent}): ${r.ids.join(", ")} · ${r.chars} chars · ${r.delivered ? "appended to the system prompt" : "not delivered (style is Claude-only for now)"}`;
}

export interface StyledPromptOpts {
  cfg?: SquadrantConfig;
  env?: NodeJS.ProcessEnv;
  /** Where generated files go. Default: <squadrant config dir>/styled-prompts. */
  outDir?: string;
}

/** The file to pass as --append-system-prompt-file: `roleFile` itself, or a generated copy with the style appended. */
export function styledPromptFile(roleFile: string, role: string, o: StyledPromptOpts = {}): string {
  try {
    const env = o.env ?? process.env;
    const root = userKbDir(o.cfg ?? (env.SQUADRANT_USER_KB_DIR ? undefined : loadConfig()), env);
    const traits = styleTraitsFor(root, role);
    if (!traits.length) return roleFile;
    const text = fs.readFileSync(roleFile, "utf8");
    const outDir = o.outDir ?? path.join(CONFIG_DIR, STYLE_DIR);
    const out = path.join(outDir, path.basename(roleFile));
    fs.mkdirSync(outDir, { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${text}${text.endsWith("\n") ? "" : "\n"}\n${renderStyleBlock(traits)}`);
    fs.renameSync(tmp, out);
    return out;
  } catch {
    return roleFile;
  }
}
