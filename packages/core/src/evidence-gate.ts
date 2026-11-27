// #1136 part 4: `crew signal done|review` evidence gate. Shared by the CLI verb and the `squadrant mcp` tools
// (both go through performCrewSignal), so every agent gets it. Reads the files `squadrant verify` writes:
// <repo>/.squadrant/verify.json (declared steps) and <repo>/.squadrant/evidence/<sha>.json.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadProjectOverride, resolveVerifyGate, type VerifyGatePolicy } from "@squadrant/shared";

export type EvidenceVerdict =
  | { kind: "skipped" }
  | { kind: "green"; sha: string }
  | { kind: "missing" | "stale" | "red"; sha: string; detail: string };

const git = (cwd: string, args: string[]): string | null => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
};

/** Evidence verdict for the repo's HEAD. `skipped` = nothing to expect (not a git repo, or no declared verify steps). */
export function evidenceVerdict(cwd: string): EvidenceVerdict {
  const repo = git(cwd, ["rev-parse", "--show-toplevel"]);
  const sha = repo ? git(repo, ["rev-parse", "HEAD"]) : null;
  if (!repo || !sha) return { kind: "skipped" };
  try {
    const cfg = JSON.parse(readFileSync(join(repo, ".squadrant", "verify.json"), "utf8")) as { steps?: unknown };
    if (!Array.isArray(cfg.steps) || cfg.steps.length === 0) return { kind: "skipped" };
  } catch {
    return { kind: "skipped" };
  }
  const dir = join(repo, ".squadrant", "evidence");
  const file = join(dir, `${sha}.json`);
  if (!existsSync(file)) {
    const others = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    return others.length
      ? { kind: "stale", sha, detail: `evidence exists only for other commits (${others.map((f) => f.slice(0, 12)).join(", ")}), not HEAD ${sha.slice(0, 12)}` }
      : { kind: "missing", sha, detail: `no evidence for HEAD ${sha.slice(0, 12)}` };
  }
  try {
    const e = JSON.parse(readFileSync(file, "utf8")) as { green?: boolean; dirty?: boolean; metaFailures?: unknown[] };
    if (e.green !== true || (e.metaFailures?.length ?? 0) > 0) {
      const n = e.metaFailures?.length ?? 0;
      return { kind: "red", sha, detail: `evidence for HEAD ${sha.slice(0, 12)} is RED${n ? ` (${n} meta-check failure${n > 1 ? "s" : ""})` : ""}` };
    }
    if (e.dirty) return { kind: "red", sha, detail: `evidence for HEAD ${sha.slice(0, 12)} was produced on a dirty tree` };
    return { kind: "green", sha };
  } catch {
    return { kind: "red", sha, detail: `evidence file for HEAD ${sha.slice(0, 12)} is unreadable` };
  }
}

export interface EvidenceGateResult {
  /** Set when the signal must be refused (throw this). */
  refuse?: string;
  /** Set when the signal proceeds but the crew should see this note. */
  warn?: string;
}

/** Pure policy decision: verdict × policy. `green`/`skipped`/`off` never block or warn. */
export function decideEvidenceGate(verdict: EvidenceVerdict, policy: VerifyGatePolicy): EvidenceGateResult {
  if (policy === "off" || verdict.kind === "skipped" || verdict.kind === "green") return {};
  const msg =
    `verify evidence ${verdict.kind.toUpperCase()}: ${verdict.detail}. ` +
    `Commit your work, then run \`squadrant verify\` at HEAD (it must exit 0) and signal again — the evidence SHA must equal HEAD.`;
  return policy === "refuse" ? { refuse: `Signal refused (verifyGate=refuse): ${msg}` } : { warn: `warning (verifyGate=warn): ${msg}` };
}

/** Gate for a `done`/`review` signal. Policy: built-in warn → defaults.verifyGate → projects/<project>.json. Never throws except to refuse. */
export function applyEvidenceGate(signal: string, o: { project?: string; cwd?: string }): EvidenceGateResult {
  if (signal !== "done" && signal !== "review") return {};
  let policy: VerifyGatePolicy;
  try {
    policy = resolveVerifyGate(loadConfig().defaults.verifyGate, o.project ? loadProjectOverride(o.project) : {});
  } catch {
    policy = resolveVerifyGate(undefined, {});
  }
  if (policy === "off") return {};
  return decideEvidenceGate(evidenceVerdict(o.cwd ?? process.cwd()), policy);
}
