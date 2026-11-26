// GitHub reactor: polls each project's open PRs (authored by the gh user) and tells the
// project captain about merge / conflict / new-comment changes. Opt-in via config.githubReactor.
//
// Initial state: the first time a project (or a PR) is seen we only RECORD a baseline
// (current mergeable state + every existing comment id) and say nothing. Later ticks diff
// against that baseline, so the captain only hears about real changes. State is persisted
// under <stateRoot>/github-reactor/<project>.json and only advanced after the captain
// message was enqueued, so a failed send is retried next tick instead of lost.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SquadrantConfig } from "@squadrant/shared";

const execFileP = promisify(execFile);

export const DEFAULT_REACTOR_INTERVAL_MS = 120_000;

export interface PrSnapshot {
  number: number;
  title: string;
  url: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** Comment ids of every kind (issue comment, review, inline review comment). */
  comments: Record<string, CommentInfo>;
}
export interface CommentInfo { author: string; kind: "comment" | "review" | "inline"; body: string; url: string; state?: string }

export interface TrackedPr {
  title: string;
  url: string;
  /** Last KNOWN (non-UNKNOWN) mergeable state. */
  mergeable: string;
  seenComments: string[];
}
export interface ProjectState { initializedAt: string; prs: Record<string, TrackedPr> }

export type PrFinal = { state: "MERGED"; by?: string; at?: string; base?: string } | { state: "CLOSED"; at?: string };

/** Pure: compare current open PRs with the stored baseline. */
export function diffProject(
  prev: ProjectState,
  open: PrSnapshot[],
  finals: Record<string, PrFinal | undefined>,
  me?: string,
): { lines: string[]; next: ProjectState } {
  const lines: string[] = [];
  const next: ProjectState = { initializedAt: prev.initializedAt, prs: {} };
  const openNums = new Set(open.map((p) => String(p.number)));

  for (const [num, tracked] of Object.entries(prev.prs)) {
    if (openNums.has(num)) continue;
    const fin = finals[num];
    if (!fin) { next.prs[num] = tracked; continue; } // can't tell yet — keep tracking
    if (fin.state === "MERGED") {
      lines.push(`✅ PR #${num} MERGED${fin.base ? ` into ${fin.base}` : ""}${fin.by ? ` by ${fin.by}` : ""}${fin.at ? ` at ${fin.at}` : ""} — ${tracked.title} (${tracked.url})`);
    } else {
      lines.push(`🚫 PR #${num} CLOSED without merge — ${tracked.title} (${tracked.url})`);
    }
  }

  for (const pr of open) {
    const key = String(pr.number);
    const old = prev.prs[key];
    if (!old) {
      // PR first seen after the project baseline: adopt silently (existing comments count as seen).
      next.prs[key] = { title: pr.title, url: pr.url, mergeable: pr.mergeable, seenComments: Object.keys(pr.comments) };
      continue;
    }
    const mergeable = pr.mergeable === "UNKNOWN" ? old.mergeable : pr.mergeable;
    if (mergeable === "CONFLICTING" && old.mergeable !== "CONFLICTING") {
      lines.push(`⚠️ PR #${key} now has MERGE CONFLICTS with its base — ${pr.title} (${pr.url})`);
    }
    const seen = new Set(old.seenComments);
    for (const [id, c] of Object.entries(pr.comments)) {
      if (seen.has(id)) continue;
      if (me && c.author === me) { seen.add(id); continue; }
      const snippet = c.body.replace(/\s+/g, " ").trim().slice(0, 240);
      const what = c.kind === "review" ? `review${c.state ? ` (${c.state})` : ""}` : c.kind === "inline" ? "inline review comment" : "comment";
      lines.push(`💬 PR #${key} new ${what} from @${c.author}${snippet ? `: "${snippet}"` : ""} (${c.url})`);
      seen.add(id);
    }
    next.prs[key] = { title: pr.title, url: pr.url, mergeable, seenComments: [...seen] };
  }
  return { lines, next };
}

// ── gh access (injectable for tests) ──────────────────────────────────────────
export interface GhApi {
  viewer(): Promise<string>;
  listOpen(cwd: string): Promise<PrSnapshot[]>;
  final(cwd: string, num: number): Promise<PrFinal | undefined>;
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export const realGh: GhApi = {
  async viewer() { return (await gh(process.cwd(), ["api", "user", "--jq", ".login"])).trim(); },
  async listOpen(cwd) {
    const list = JSON.parse(await gh(cwd, ["pr", "list", "--author", "@me", "--state", "open", "--limit", "50",
      "--json", "number,title,url,mergeable,comments,reviews"])) as Array<{
        number: number; title: string; url: string; mergeable: string;
        comments: Array<{ id: string; author: { login: string }; body: string; url: string }>;
        reviews: Array<{ id: string; author: { login: string }; body: string; state: string }>;
      }>;
    const out: PrSnapshot[] = [];
    for (const p of list) {
      const comments: Record<string, CommentInfo> = {};
      for (const c of p.comments) comments[c.id] = { author: c.author?.login ?? "unknown", kind: "comment", body: c.body, url: c.url };
      for (const r of p.reviews) comments[r.id] = { author: r.author?.login ?? "unknown", kind: "review", body: r.body, url: p.url, state: r.state };
      // Inline (line-level) review comments are not in `gh pr list`.
      const inline = JSON.parse(await gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${p.number}/comments`, "--paginate", "--slurp"])) as
        Array<Array<{ id: number; user: { login: string }; body: string; html_url: string }>>;
      for (const c of inline.flat()) comments[`inline:${c.id}`] = { author: c.user?.login ?? "unknown", kind: "inline", body: c.body, url: c.html_url };
      out.push({ number: p.number, title: p.title, url: p.url, mergeable: p.mergeable, comments });
    }
    return out;
  },
  async final(cwd, num) {
    const v = JSON.parse(await gh(cwd, ["pr", "view", String(num), "--json", "state,mergedAt,mergedBy,closedAt,baseRefName"])) as
      { state: string; mergedAt?: string; mergedBy?: { login: string }; closedAt?: string; baseRefName?: string };
    if (v.state === "MERGED") return { state: "MERGED", by: v.mergedBy?.login, at: v.mergedAt, base: v.baseRefName };
    if (v.state === "CLOSED") return { state: "CLOSED", at: v.closedAt };
    return undefined;
  },
};

// ── persistence ───────────────────────────────────────────────────────────────
function stateFile(stateRoot: string, project: string): string {
  return path.join(stateRoot, "github-reactor", `${project}.json`);
}
export function readProjectState(stateRoot: string, project: string): ProjectState | undefined {
  try { return JSON.parse(fs.readFileSync(stateFile(stateRoot, project), "utf8")) as ProjectState; } catch { return undefined; }
}
export function writeProjectState(stateRoot: string, project: string, s: ProjectState): void {
  const f = stateFile(stateRoot, project);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
  fs.renameSync(f + ".tmp", f);
}

// ── tick ──────────────────────────────────────────────────────────────────────
export interface ReactorOpts {
  stateRoot: string;
  config: SquadrantConfig;
  /** True when the project's captain is up (only open projects are polled). */
  isOpen: (project: string) => Promise<boolean>;
  appendCaptainMessage: (project: string, text: string) => Promise<void | number>;
  api?: GhApi;
  log?: (m: string) => void;
  now?: () => Date;
}

export function reactorEnabled(config: SquadrantConfig): boolean {
  return config.githubReactor?.enabled === true;
}

/** One polling pass. Never throws; a failure in one project never affects another. */
export async function runGithubReactorTick(opts: ReactorOpts): Promise<void> {
  if (!reactorEnabled(opts.config)) return;
  const api = opts.api ?? realGh;
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date()))();
  let me: string | undefined;
  try { me = await api.viewer(); } catch (e) { log(`github-reactor: gh not usable: ${(e as Error).message}`); return; }

  for (const [project, proj] of Object.entries(opts.config.projects)) {
    try {
      if (!(await opts.isOpen(project))) continue;
      const open = await api.listOpen(proj.path);
      const prev = readProjectState(opts.stateRoot, project);
      if (!prev) {
        // Baseline: record everything currently true, notify nothing.
        const prs: Record<string, TrackedPr> = {};
        for (const p of open) prs[String(p.number)] = { title: p.title, url: p.url, mergeable: p.mergeable, seenComments: Object.keys(p.comments) };
        writeProjectState(opts.stateRoot, project, { initializedAt: now.toISOString(), prs });
        log(`github-reactor: ${project}: baseline of ${open.length} open PR(s) recorded`);
        continue;
      }
      const openNums = new Set(open.map((p) => String(p.number)));
      const finals: Record<string, PrFinal | undefined> = {};
      for (const num of Object.keys(prev.prs)) {
        if (!openNums.has(num)) finals[num] = await api.final(proj.path, Number(num)).catch(() => undefined);
      }
      const { lines, next } = diffProject(prev, open, finals, me);
      if (lines.length > 0) {
        await opts.appendCaptainMessage(project, `GitHub update for ${project}:\n${lines.join("\n")}`);
      }
      writeProjectState(opts.stateRoot, project, next); // only after a successful send
    } catch (e) {
      log(`github-reactor: ${project}: ${(e as Error).message}`);
    }
  }
}
