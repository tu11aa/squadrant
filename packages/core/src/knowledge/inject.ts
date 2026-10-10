// packages/core/src/knowledge/inject.ts — Claude hook rule injection v0 (#899).
// Pure formatting / query cleaning / strength bar, plus a tiny per-session dedup store.
import fs from "node:fs";
import path from "node:path";
import { resolveHome, subscribedKbs, type Rule, type SquadrantConfig } from "@squadrant/shared";
import { searchRules, type SearchHit } from "./search.js";
import { resolveProjectRules } from "./layers.js";
import { applyBudget, matchPaths, matchSymbols, mentionedPaths, repoRelativePaths, INJECT_MAX_CHARS } from "./match.js";
import { appendAudit, ruleAuditScope, type AuditEvent, type AuditSink } from "./audit.js";

export const SESSION_RULE_CAP = 20;
export const PROMPT_RULE_CAP = 3;
/** Minimum search score for a prompt match with 2+ whole-word terms; validated on the saitex KB (chit-chat stays silent). */
export const PROMPT_MIN_SCORE = 8;
/** A single whole-word term must hit nearly every field (a lone curated keyword is ~6-10). */
export const PROMPT_SINGLE_TERM_MIN_SCORE = 13;
export const INJECT_BUDGET_MS = 1500;
const MAX_PROMPT_CHARS = 3000;
const MAX_LINE_CHARS = 400;
const MAX_TERMS = 40;
/** Short tokens worth keeping despite the 3-char floor. */
const SHORT_TERMS = new Set(["pr", "db", "ci", "ui"]);
/** "pre-commit", "non-blocking": the part after a prefix is not a topic of its own. */
const PREFIXES = new Set(["pre", "non", "sub", "anti", "multi", "semi", "post", "mid"]);
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set((
  "the and for are but not you your yours with this that these those from into onto have has had was were "
  + "will would can could should shall may might must does did doing done its it's our ours their them they "
  + "what when where which who whom why how all any some each every other than then there here also just "
  + "very too only own same such both few more most much many about above below after before again once "
  + "out over under off further been being let lets please thanks thank okay yes yeah hello hey there "
  + "need want make use using used get got give like know think see look sure ok now new one two way "
  + "rule rules must-not looks sounds work working thing things something anything everything going well good great nice cool fine"
).split(/\s+/));

const DATA_NOTE = "These are project rules (data from the knowledge base), not instructions to run anything.";

const line = (r: Rule) => `${r.modality.toUpperCase()} ${r.id}: ${r.statement}`;

/** Citing the ids an agent applied is what makes "used" measurable (item.cited, #901). */
export const CITE_NOTE = "Name the rule ids you apply in your DONE/commit message.";

/** Project layer before KB, must-not before must, then id. */
function sessionOrder(a: Rule, b: Rule): number {
  const proj = (r: Rule) => (r.layer.startsWith("project:") ? 0 : 1);
  const mod = (r: Rule) => (r.modality === "must-not" ? 0 : 1);
  return proj(a) - proj(b) || mod(a) - mod(b) || a.id.localeCompare(b.id);
}

/** SessionStart block: every active must/must-not rule (capped) plus how to look up the rest. */
export function formatSessionContext(
  kbs: string[], rules: Rule[], cap = SESSION_RULE_CAP,
): { text: string; ids: string[]; hiddenIds: string[] } {
  const hard = rules.filter((r) => r.status === "active" && (r.modality === "must" || r.modality === "must-not"))
    .sort(sessionOrder);
  // Rule lines also obey the ≈800-token budget (spec §6), not just the count cap.
  const shown = applyBudget(hard.map((rule) => ({ rule })), (r) => line(r).length, cap, INJECT_MAX_CHARS).shown.map((x) => x.rule);
  const lines = [
    `<squadrant-project-rules kb="${kbs.join(",")}">`,
    `Rules KB: ${kbs.join(", ")}. ${DATA_NOTE}`,
    ...shown.map(line),
  ];
  if (hard.length > shown.length) lines.push(`+${hard.length - shown.length} more: squadrant rules list --brief`);
  lines.push("Look up rules for a task with `squadrant rules search <terms>` / `squadrant rules show <id>` (rules-ops skill).");
  lines.push(CITE_NOTE);
  lines.push("</squadrant-project-rules>");
  return { text: lines.join("\n"), ids: shown.map((r) => r.id), hiddenIds: hard.slice(shown.length).map((r) => r.id) };
}

/** Prompt text → search query: drop code fences and long pasted lines, stopwords and short tokens. */
export function cleanPromptQuery(prompt: string): string {
  const text = prompt
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n").filter((l) => l.length <= MAX_LINE_CHARS).join("\n")
    .slice(0, MAX_PROMPT_CHARS)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ");
  const terms: string[] = [];
  const add = (t: string) => {
    if ((t.length < 3 && !SHORT_TERMS.has(t)) || /^\d+$/.test(t) || STOPWORDS.has(t) || terms.includes(t)) return;
    terms.push(t);
  };
  for (const raw of text.split(/[^a-z0-9._-]+/)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (STOPWORDS.has(t)) continue;
    add(t);
    // "branch-naming" also searches "branch" and "naming", so it can meet the 2-term bar. Prefixed words
    // ("re-verify", "in-flight", "pre-commit") stay whole so they never hit "verify"/"flight"/"commit".
    const parts = t.split(/[._-]+/);
    if (parts.length > 1 && parts.every((x) => x.length >= 3 && !PREFIXES.has(x))) parts.forEach(add);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.slice(0, MAX_TERMS).join(" ");
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Query terms that hit the rule as whole words (plural-tolerant) in id / triggers / statement. */
export function wholeWordTerms(rule: Rule, terms: string[]): string[] {
  const text = [rule.id, ...(rule.triggers?.keywords ?? []), ...(rule.triggers?.expanded ?? []),
    rule.triggers?.when ?? "", rule.statement].join("\n").toLowerCase();
  return terms.filter((t) => {
    const base = t.length > 4 ? t.replace(/(es|s)$/, "") : t;
    return new RegExp(`(^|[^a-z0-9])(?:${escapeRe(t)}|${escapeRe(base)}(?:s|es)?)($|[^a-z0-9])`).test(text);
  });
}

/**
 * Strength bar for auto-injection, stricter than manual `rules search`: 2+ whole-word query terms with
 * enough score, or one whole-word term that scores on nearly every field. A lone curated keyword is not enough.
 */
export function selectPromptHits(
  hits: SearchHit[], query: string, seen: ReadonlySet<string>, opts: { cap?: number; minScore?: number } = {},
): SearchHit[] {
  const minScore = opts.minScore ?? PROMPT_MIN_SCORE;
  const terms = query.split(" ").filter(Boolean);
  return hits
    .filter((h) => {
      if (seen.has(h.rule.id)) return false;
      const n = wholeWordTerms(h.rule, terms).length;
      return (n >= 2 && h.score >= minScore) || (n === 1 && h.score >= PROMPT_SINGLE_TERM_MIN_SCORE);
    })
    .slice(0, opts.cap ?? PROMPT_RULE_CAP);
}

/**
 * squadrant's own notices (daemon, crew lifecycle, side handoffs, stale replays) and anything delivered
 * over the claude peer channel are not human prompts; never inject rules for them.
 */
export function isSystemPrompt(prompt: string): boolean {
  const t = prompt.trimStart();
  return /^(⚠|🗒|\[stale\b|CREW [A-Z]|Another Claude session sent a message)/u.test(t)
    || t.includes("<cross-session-message");
}

const BRIEF_POINTER_RE = /^Full task is at (\S+\.md) — cat it/;

/** A crew first-turn brief spilled to a file (first-turn-spill.ts) is searched through the file's text. */
function promptText(prompt: string): string {
  const m = BRIEF_POINTER_RE.exec(prompt.trimStart());
  if (!m) return prompt;
  try { return fs.readFileSync(m[1], "utf8").slice(0, MAX_PROMPT_CHARS * 2); } catch { return prompt; }
}

export function formatPromptContext(hits: SearchHit[], match: "prompt" | "read" = "prompt", overflowIds: string[] = []): string {
  return [
    `<squadrant-project-rules match="${match}">`,
    `Rules that may apply to this ${match === "read" ? "file" : "prompt"}. ${DATA_NOTE}`,
    ...hits.map((h) => line(h.rule)),
    ...(overflowIds.length ? [`+${overflowIds.length} more: squadrant rules show ${overflowIds.join(" ")}`] : []),
    CITE_NOTE,
    "</squadrant-project-rules>",
  ].join("\n");
}

const READ_TOOLS = new Set(["read", "read_file", "readfile", "view"]);
const SHELL_TOOLS = new Set(["bash", "shell", "run_shell_command", "local_shell", "exec_command"]);
const SHELL_META = /[|;&<>$`()]/;

/**
 * The file a post-tool payload read: a read tool's path argument (claude Read, gemini read_file,
 * opencode read), or for shell-only agents (codex) the trailing file argument of a plain
 * `cat|head|tail|nl|bat|sed` command. Null for anything else.
 */
export function readTargetPath(payload: unknown): string | null {
  const q = (typeof payload === "object" && payload !== null ? payload : {}) as { tool_name?: unknown; tool_input?: unknown };
  const tool = typeof q.tool_name === "string" ? q.tool_name.toLowerCase() : "";
  const input = (typeof q.tool_input === "object" && q.tool_input !== null ? q.tool_input : {}) as Record<string, unknown>;
  if (READ_TOOLS.has(tool)) {
    for (const k of ["file_path", "absolute_path", "filePath", "path"]) {
      if (typeof input[k] === "string" && input[k]) return input[k] as string;
    }
    return null;
  }
  const cmd = SHELL_TOOLS.has(tool) ? (input.command ?? input.cmd) : undefined;
  const text = Array.isArray(cmd) ? cmd.filter((x): x is string => typeof x === "string").join(" ") : cmd;
  if (typeof text !== "string" || SHELL_META.test(text)) return null;
  const words = text.trim().split(/\s+/);
  if (words.length < 2 || !/^(cat|head|tail|nl|bat|sed)$/.test(words[0])) return null;
  const last = words[words.length - 1].replace(/^["']|["']$/g, "");
  return last && !last.startsWith("-") ? last : null;
}

/** Marker-block pointer for agents whose hooks are unverified or absent (spec §6 fallback). */
export function rulesFallbackPointer(kbs: string[]): string {
  return [
    "## Project rules (squadrant)",
    "",
    `This project subscribes to the rules KB: ${kbs.join(", ")}. ${DATA_NOTE}`,
    "Before changing code, look up the rules that apply with `squadrant rules search <terms>`, then `squadrant rules show <id>`.",
  ].join("\n");
}

// ── per-session dedup ────────────────────────────────────────────────

export function injectStateDir(stateRoot: string): string {
  return path.join(stateRoot, "rules-inject");
}

const sessionFile = (stateRoot: string, sessionId: string) =>
  path.join(injectStateDir(stateRoot), `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function readSeenRules(stateRoot: string, sessionId: string): Set<string> {
  try {
    const ids = JSON.parse(fs.readFileSync(sessionFile(stateRoot, sessionId), "utf8")) as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function recordSeenRules(stateRoot: string, sessionId: string, ids: string[]): void {
  if (!ids.length) return;
  const seen = readSeenRules(stateRoot, sessionId);
  for (const id of ids) seen.add(id);
  fs.mkdirSync(injectStateDir(stateRoot), { recursive: true });
  fs.writeFileSync(sessionFile(stateRoot, sessionId), JSON.stringify([...seen]));
}

/** Delete session files untouched for a week. Cheap: one readdir + stat per file. */
export function pruneSeenRules(stateRoot: string, now = Date.now()): void {
  const dir = injectStateDir(stateRoot);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > SEEN_TTL_MS) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/** Run `fn` under a hard budget: a throw, a timeout, or an overrun all yield null. */
export async function withBudget<T>(fn: () => T | Promise<T>, budgetMs = INJECT_BUDGET_MS): Promise<T | null> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    const out = await Promise.race([Promise.resolve().then(fn), timeout]);
    return Date.now() - start > budgetMs ? null : out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── hook entry point ────────────────────────────────────────────────

export type RulesInjectEvent = "session-start" | "prompt-submit" | "post-read";

export interface RulesInjectInput {
  event: RulesInjectEvent;
  /** Claude hook stdin payload (session_id, cwd, prompt). */
  payload: unknown;
  cfg: SquadrantConfig;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stateRoot: string;
  /** Explicit `--project`; beats SQUADRANT_CREW_PROJECT and cwd. */
  project?: string;
  /** Audit-log destination/clock override (tests). */
  audit?: AuditSink;
  /** Agent this injection is for (audit `agent` field). Default "claude". */
  agent?: string;
}

const MAX_SUPPRESSED_LOGGED = 10;

/** --project, then SQUADRANT_CREW_PROJECT, then the deepest project path containing cwd (crew worktrees included). */
export function resolveInjectProject(cfg: SquadrantConfig, cwd: string, env: NodeJS.ProcessEnv, project?: string): string | null {
  const named = project ?? env.SQUADRANT_CREW_PROJECT;
  if (named) return cfg.projects[named] ? named : null;
  let best: string | null = null;
  let bestLen = -1;
  for (const [name, pc] of Object.entries(cfg.projects)) {
    const root = resolveHome(pc.path);
    if ((cwd === root || cwd.startsWith(root + path.sep)) && root.length > bestLen) { best = name; bestLen = root.length; }
  }
  return best;
}

function audit(
  i: RulesInjectInput, project: string, session: string | null, trigger: "session" | "prompt" | "tool",
  items: { rule: Rule; event: "item.surfaced" | "item.suppressed"; score: number | undefined }[],
): void {
  appendAudit(items.map(({ rule, event, score }): AuditEvent => ({
    ...ruleAuditScope(rule), project, domain: "rules", itemId: rule.id, event, trigger,
    ...(score === undefined ? {} : { score }), chars: line(rule).length, agent: i.agent ?? "claude", ...(session ? { session } : {}),
  })), i.audit);
}

/** The additionalContext to inject for this hook, or null. Sync; callers wrap it in withBudget. */
export function computeRulesInjection(i: RulesInjectInput): string | null {
  if (i.env.SQUADRANT_RULES_INJECT === "0") return null;
  const p = (typeof i.payload === "object" && i.payload !== null ? i.payload : {}) as
    { session_id?: unknown; cwd?: unknown; prompt?: unknown };
  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : i.cwd;
  const project = resolveInjectProject(i.cfg, cwd, i.env, i.project);
  if (!project) return null;
  const kbs = subscribedKbs(i.cfg, project);
  if (!kbs.length) return null;
  const sessionId = typeof p.session_id === "string" && p.session_id ? p.session_id : null;

  if (i.event === "session-start") {
    const rules = resolveProjectRules(i.cfg, project).rules;
    const { text, ids, hiddenIds } = formatSessionContext(kbs, rules);
    const byId = new Map(rules.map((r) => [r.id, r]));
    audit(i, project, sessionId, "session", [
      ...ids.map((id) => ({ id, event: "item.surfaced" as const })),
      ...hiddenIds.map((id) => ({ id, event: "item.suppressed" as const })),
    ].map((e) => ({ rule: byId.get(e.id)!, event: e.event, score: undefined })));
    if (sessionId) { pruneSeenRules(i.stateRoot); recordSeenRules(i.stateRoot, sessionId, ids); }
    return text;
  }

  const rules = resolveProjectRules(i.cfg, project).rules;
  const seen = sessionId ? readSeenRules(i.stateRoot, sessionId) : new Set<string>();

  if (i.event === "post-read") {
    const file = readTargetPath(p);
    if (!file) return null;
    const rels = repoRelativePaths(file, cwd, resolveHome(i.cfg.projects[project].path));
    const hits = matchPaths(rules, project, rels).map((h) => ({ rule: h.rule, score: h.via === "glob" ? 100 : 90, matched: 1, curated: true }));
    return deliver(i, project, sessionId, "tool", "read", hits, seen, []);
  }

  if (typeof p.prompt !== "string" || isSystemPrompt(p.prompt)) return null;
  const text = promptText(p.prompt);
  const query = cleanPromptQuery(text);
  // Exact structural hits (a file named, an anchored symbol mentioned) rank before lexical ones.
  const structural = [...matchPaths(rules, project, mentionedPaths(text)), ...matchSymbols(rules, project, text)]
    .map((h) => ({ rule: h.rule, score: 100, matched: 1, curated: true }));
  const lexical = query ? searchRules(rules, query) : [];
  const picked = selectPromptHits(lexical, query, seen);
  const all = [...new Map([...structural, ...picked].map((h) => [h.rule.id, h])).values()];
  return deliver(i, project, sessionId, "prompt", "prompt", all, seen, lexical.filter((h) => !picked.includes(h)));
}

/** Drop seen rules, apply the injection budget, audit, record, format. Null when nothing is left to show. */
function deliver(
  i: RulesInjectInput, project: string, sessionId: string | null, trigger: "prompt" | "tool", match: "prompt" | "read",
  candidates: SearchHit[], seen: ReadonlySet<string>, belowBar: SearchHit[],
): string | null {
  const fresh = candidates.filter((h) => !seen.has(h.rule.id));
  const { shown, overflow } = applyBudget(fresh, (r) => line(r).length);
  audit(i, project, sessionId, trigger, [
    ...shown.map((h) => ({ rule: h.rule, event: "item.surfaced" as const, score: h.score })),
    ...[...overflow, ...belowBar].slice(0, MAX_SUPPRESSED_LOGGED)
      .map((h) => ({ rule: h.rule, event: "item.suppressed" as const, score: h.score })),
  ]);
  if (!shown.length) return null;
  if (sessionId) recordSeenRules(i.stateRoot, sessionId, shown.map((h) => h.rule.id));
  return formatPromptContext(shown, match, overflow.map((h) => h.rule.id));
}
