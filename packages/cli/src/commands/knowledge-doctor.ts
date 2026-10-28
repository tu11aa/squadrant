// packages/cli/src/commands/knowledge-doctor.ts — `squadrant knowledge doctor [kb]` (#979, spec 2026-10-27 §4.1, §4.6).
// Read-only apart from rebuilding the derived index cache (K8). `--fix` (commit/untrack) belongs to 2b-1.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, userKbDir, DEFAULT_CONFIG_PATH, KB_NAME_RE, USER_KB, type SquadrantConfig } from "@squadrant/shared";
import {
  allKbNames, auditHealth, compileIndex, kbDir, legacyIndexHint, loadKbItems, loadKbRules, readIndex, validateKbItems, writeIndex, type KbCheck,
} from "@squadrant/core";

/** K8: the index cache is derived, so a missing or corrupt one is rebuilt from the KB's live rules. Returns what was wrong. */
export function ensureIndexCache(cfg: SquadrantConfig, kb: string): { problem?: string; file?: string } {
  const { problem } = readIndex(kb);
  if (!problem) return {};
  return { problem, file: writeIndex(kbDir(cfg, kb), compileIndex(kb, loadKbRules(cfg, kb).rules)) };
}

/** Index cache + legacy `index.json` lines of one rules KB. */
export function indexChecks(cfg: SquadrantConfig, kb: string): KbCheck[] {
  const { problem, file } = ensureIndexCache(cfg, kb);
  const checks: KbCheck[] = [{ level: "ok", message: problem ? `${kb}: index cache rebuilt (${problem}) → ${file}` : `${kb}: index cache valid` }];
  const legacy = legacyIndexHint(kbDir(cfg, kb));
  if (legacy) checks.push({ level: "warn", message: `${kb}: index.json in the KB repo is no longer used (the index is a cache now) → run: ${legacy}` });
  return checks;
}

/** Item checks of one KB: D3/D4 + common fields over every domain folder (incl. `_proposed/`), plus loader errors. */
export function itemChecks(cfg: SquadrantConfig, kb: string): KbCheck[] {
  const root = kb === USER_KB ? userKbDir(cfg) : kbDir(cfg, kb);
  const loaded = loadKbItems(cfg, kb);
  const byFile = new Map<string, Set<string>>();
  for (const e of [...validateKbItems(cfg, kb), ...loaded.errors]) {
    const set = byFile.get(e.file) ?? new Set<string>();
    for (const p of e.problems) set.add(p);
    byFile.set(e.file, set);
  }
  if (!byFile.size) return [{ level: "ok", message: `${kb}: ${loaded.items.length} live items valid` }];
  return [...byFile].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, ps]) => ({ level: "fail" as const, message: `${kb}: ${path.relative(root, file)}: ${[...ps].join("; ")}` }));
}

/** Audit-log health (spec §4.6, C4): lines whose kb no config ever had (the `kb: "t"` test leak) are ignored by scoring; no-home lines show as `(no home)`. */
export function globalChecks(cfg: SquadrantConfig, auditDir?: string): KbCheck[] {
  const { ignored, noHome } = auditHealth({ cfg, dir: auditDir });
  const bad = Object.entries(ignored).sort(([a], [b]) => a.localeCompare(b));
  return [
    bad.length
      ? { level: "warn", message: `audit log: ${bad.reduce((n, [, c]) => n + c, 0)} lines ignored by scoring, kb unknown to config: ${bad.map(([kb, n]) => `${JSON.stringify(kb)} ${n}`).join(", ")}` }
      : { level: "ok", message: "audit log: every line belongs to a known KB" },
    ...(noHome ? [{ level: "warn" as const, message: `audit log: ${noHome} lines from projects with no knowledge home, shown as (no home) in knowledge stats` }] : []),
  ];
}

export function runKnowledgeDoctor(kb?: string, configPath = DEFAULT_CONFIG_PATH): { checks: KbCheck[]; ok: boolean } {
  if (kb !== undefined && kb !== USER_KB && !KB_NAME_RE.test(kb)) throw new Error(`Invalid knowledge base name '${kb}' (use lowercase letters, digits, '-')`);
  const cfg = loadConfig(configPath);
  const checks: KbCheck[] = [];
  for (const name of kb ? [kb] : allKbNames(cfg)) {
    const root = name === USER_KB ? userKbDir(cfg) : kbDir(cfg, name);
    if (!fs.existsSync(root)) {
      checks.push({ level: kb ? "fail" : "warn", message: `${name}: not found at ${root}` });
      continue;
    }
    checks.push(...itemChecks(cfg, name));
    if (name !== USER_KB) checks.push(...indexChecks(cfg, name));
  }
  checks.push(...globalChecks(cfg));
  return { checks, ok: !checks.some((c) => c.level === "fail") };
}

export const knowledgeDoctorCommand = new Command("doctor")
  .argument("[kb]", "one KB (default: every configured KB plus _user)")
  .description("Check KB items (folder domain D3, reserved id prefixes D4, common fields) and rebuild a missing index cache; exits non-zero on item failures")
  .action((kb?: string) => {
    const { checks, ok } = runKnowledgeDoctor(kb);
    const mark = { ok: chalk.green("✔"), fail: chalk.red("✘"), warn: chalk.yellow("!"), skip: chalk.dim("-") };
    for (const c of checks) console.log(`${mark[c.level]} ${c.message}`);
    console.log(ok ? chalk.green("healthy") : chalk.red("problems found"));
    if (!ok) process.exitCode = 1;
  });
