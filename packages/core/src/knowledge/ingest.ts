// packages/core/src/knowledge/ingest.ts — detect → convert → section plan (rules spec §4 steps 1-3, #897).
// Everything mechanical lives here; the LLM extraction step is the `knowledge-extract` skill.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KnowledgeSourceEntry } from "@squadrant/shared";

const execFileAsync = promisify(execFile);

export const CONVERTED_DIR = ".converted";
export const DEFAULT_MAX_SECTIONS_PER_PASS = 40;
/** Rough chars-per-token for the first-ingest estimate. */
export const CHARS_PER_TOKEN = 4;
const PASS_THROUGH = new Set([".md", ".markdown", ".txt"]);
const SECTION_TARGET_CHARS = 4000;

/** Converter seam: source file → markdown text. Default shells out to markitdown. */
export type Converter = (file: string) => Promise<string>;

export const markitdownConverter: Converter = async (file) => {
  const { stdout } = await execFileAsync("markitdown", [file], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

export interface SourceStamp { sha: string; size: number; mtimeMs: number }
export interface SourceState extends SourceStamp {
  ref: string;
  /** Sections already handed to the extractor; a source is clean when cursor >= section count. */
  cursor: number;
  sections: number;
  /** Set once a pass has completed it; cleared when the file changes. */
  priority?: string;
}

export interface SectionSpan { index: number; start: number; end: number; heading?: string }

export interface PlanSource {
  ref: string;
  file: string;
  converted: string;
  sha: string;
  priority: string;
  domain?: string;
  sensitivity?: "local-only";
  sections: SectionSpan[];
  /** Total sections of this source, including ones carried to a later pass. */
  totalSections: number;
}
export interface IngestPlan {
  sources: PlanSource[];
  /** Sources not processed this pass, with the reason. */
  skipped: { ref: string; reason: string }[];
  failed: { ref: string; error: string }[];
  /** Sections held back by maxSectionsPerPass; the next pass picks them up. */
  carriedSections: number;
  sectionCount: number;
  estimatedTokens: number;
  /** Compact index of live rules the extractor may reuse ids from (id + statement). */
  existing: { id: string; domain: string; statement: string }[];
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** How a source is named in rule `sources[].ref`: relative to the KB, else `~/…`, else absolute. */
export function refFor(kbRoot: string, file: string): string {
  const rel = path.relative(kbRoot, file);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~/${path.relative(home, file).split(path.sep).join("/")}` : file;
}
export const fileForRef = (kbRoot: string, ref: string): string => path.resolve(kbRoot, expandHome(ref));

const cacheKey = (ref: string) =>
  `${ref.replace(/[^A-Za-z0-9._-]+/g, "_")}.${crypto.createHash("sha1").update(ref).digest("hex").slice(0, 6)}`;
export const convertedFile = (kbRoot: string, ref: string) => path.join(kbRoot, CONVERTED_DIR, `${cacheKey(ref)}.md`);
const stampFile = (kbRoot: string, ref: string) => path.join(kbRoot, CONVERTED_DIR, `${cacheKey(ref)}.sha`);

export function readState(kbRoot: string, ref: string): SourceState | null {
  try { return JSON.parse(fs.readFileSync(stampFile(kbRoot, ref), "utf8")) as SourceState; } catch { return null; }
}
function writeState(kbRoot: string, st: SourceState): void {
  fs.mkdirSync(path.join(kbRoot, CONVERTED_DIR), { recursive: true });
  fs.writeFileSync(stampFile(kbRoot, st.ref), JSON.stringify(st) + "\n");
}

/** `*` (no slash), `**` (any depth), `?`. Enough for sources.yaml; anchors are never parsed with it. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === CONVERTED_DIR || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/** Expand one sources.yaml entry to concrete files (a glob becomes one tracked entry per file). */
export function expandSource(kbRoot: string, entry: KnowledgeSourceEntry): string[] {
  const abs = path.resolve(kbRoot, expandHome(entry.path));
  if (!/[*?]/.test(entry.path)) return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
  const base = abs.split(/[*?]/)[0];
  const root = base.endsWith(path.sep) ? base : path.dirname(base);
  const re = globToRegExp(abs.split(path.sep).join("/"));
  return walkFiles(root).filter((f) => re.test(f.split(path.sep).join("/"))).sort();
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** mtime+size first; the sha is computed only when one of them differs (spec §4 step 1). */
export function detectChange(kbRoot: string, file: string): { ref: string; changed: boolean; stamp: SourceStamp; prior: SourceState | null } {
  const ref = refFor(kbRoot, file);
  const st = fs.statSync(file);
  const prior = readState(kbRoot, ref);
  if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
    return { ref, changed: false, stamp: { sha: prior.sha, size: st.size, mtimeMs: st.mtimeMs }, prior };
  }
  const sha = sha256(file);
  return { ref, changed: !prior || prior.sha !== sha, stamp: { sha, size: st.size, mtimeMs: st.mtimeMs }, prior };
}

/** Split converted markdown at headings; headingless text is chunked at paragraph breaks. */
export function splitSections(text: string): SectionSpan[] {
  const cuts: { at: number; heading?: string }[] = [];
  const re = /^#{1,6}[ \t]+(.+)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) cuts.push({ at: m.index, heading: m[1].trim() });
  if (!cuts.length || cuts[0].at > 0) cuts.unshift({ at: 0 });
  const spans: SectionSpan[] = [];
  cuts.forEach((c, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : text.length;
    let start = c.at;
    while (end - start > SECTION_TARGET_CHARS * 1.5) {
      const brk = text.indexOf("\n\n", start + SECTION_TARGET_CHARS);
      if (brk < 0 || brk >= end) break;
      spans.push({ index: 0, start, end: brk, heading: c.heading });
      start = brk + 2;
    }
    if (text.slice(start, end).trim()) spans.push({ index: 0, start, end, heading: c.heading });
  });
  return spans.map((s, i) => ({ ...s, index: i }));
}

export interface IngestOptions {
  sources: KnowledgeSourceEntry[];
  /** Hard cap on sections handed out in one pass (spec §4 first-ingest guard). */
  maxSectionsPerPass?: number;
  /** A local model is available for `sensitivity: local-only` sources; otherwise they are skipped. */
  localModel?: boolean;
  converter?: Converter;
  /** Estimate only: no conversion cache, cursor or stamp is written. */
  dryRun?: boolean;
  existing?: IngestPlan["existing"];
}

export async function planIngest(kbRoot: string, opts: IngestOptions): Promise<IngestPlan> {
  const converter = opts.converter ?? markitdownConverter;
  const cap = opts.maxSectionsPerPass ?? DEFAULT_MAX_SECTIONS_PER_PASS;
  const plan: IngestPlan = { sources: [], skipped: [], failed: [], carriedSections: 0, sectionCount: 0, estimatedTokens: 0, existing: opts.existing ?? [] };
  let budget = cap;
  const seen = new Set<string>();

  for (const entry of opts.sources) {
    for (const file of expandSource(kbRoot, entry)) {
      const { ref, changed, stamp, prior } = detectChange(kbRoot, file);
      if (seen.has(ref)) continue;
      seen.add(ref);
      const pending = !!prior && prior.cursor < prior.sections;
      if (!changed && !pending) continue;
      if (entry.sensitivity === "local-only" && !opts.localModel) {
        plan.skipped.push({ ref, reason: "sensitivity: local-only and no local model available" });
        continue;
      }
      if (budget <= 0) { plan.carriedSections += changed ? 1 : (prior!.sections - prior!.cursor); continue; }

      let text: string;
      const conv = convertedFile(kbRoot, ref);
      try {
        if (!changed && fs.existsSync(conv)) text = fs.readFileSync(conv, "utf8");
        else {
          text = PASS_THROUGH.has(path.extname(file).toLowerCase()) ? fs.readFileSync(file, "utf8") : await converter(file);
          if (!opts.dryRun) { fs.mkdirSync(path.dirname(conv), { recursive: true }); fs.writeFileSync(conv, text); }
        }
      } catch (e) {
        plan.failed.push({ ref, error: (e as Error).message.split("\n")[0] });
        continue;
      }

      const all = splitSections(text);
      const from = changed ? 0 : prior!.cursor;
      const take = all.slice(from, from + budget);
      budget -= take.length;
      plan.carriedSections += all.length - from - take.length;
      plan.sectionCount += take.length;
      plan.estimatedTokens += Math.ceil(take.reduce((n, s) => n + (s.end - s.start), 0) / CHARS_PER_TOKEN);
      plan.sources.push({
        ref, file, converted: conv, sha: stamp.sha, priority: entry.priority, domain: entry.domain,
        sensitivity: entry.sensitivity, sections: take, totalSections: all.length,
      });
      if (!opts.dryRun) writeState(kbRoot, { ref, ...stamp, sections: all.length, cursor: from + take.length, priority: entry.priority });
    }
  }
  return plan;
}
