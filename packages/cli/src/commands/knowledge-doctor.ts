// packages/cli/src/commands/knowledge-doctor.ts — `squadrant knowledge doctor [kb] [--fix]` (#979, spec 2026-10-27 §4.1, §4.6, §5, C3).
// Two halves: is each KB repo clean after squadrant writes (D7; --fix repairs it, outside edits need a y/n), and are its
// items valid (D3/D4, common fields), its index cache present (K8) and the audit log healthy. Only --fix and the cache rebuild write.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, kbConfigs, userKbDir, DEFAULT_CONFIG_PATH, KB_NAME_RE, USER_KB, type SquadrantConfig } from "@squadrant/shared";
import {
  allKbNames, auditHealth, checkKbRepo, compileIndex, fixKbRepo, kbDir, legacyIndexHint, loadKbItems, loadKbRules, readIndex, validateKbItems, writeIndex,
  type KbCheck, type KbRepoCheck, type KbRepoFix,
} from "@squadrant/core";

export interface KbDoctorEntry { check: KbRepoCheck; fix?: KbRepoFix }

/** Phase 2 §5 / C3: is each KB repo clean? --fix runs the mechanical fixes; other changes are committed only on `confirm`.
 *  Without a name: every configured KB that exists on disk (a missing one is reported by runKnowledgeDoctor). */
export function runKbRepoDoctor(
  kb: string | undefined, o: { fix?: boolean; confirm?: (kb: string, files: string[]) => boolean } = {}, configPath = DEFAULT_CONFIG_PATH,
): KbDoctorEntry[] {
  const cfg = loadConfig(configPath);
  const kbs = kb ? [kb] : Object.keys(kbConfigs(cfg)).filter((k) => KB_NAME_RE.test(k) && fs.existsSync(kbDir(cfg, k))); // `_user`: squadrant profile list --check
  return kbs.map((k) => {
    if (!KB_NAME_RE.test(k)) throw new Error(`Invalid knowledge base name '${k}' (use lowercase letters, digits, '-')`);
    const root = kbDir(cfg, k);
    if (!fs.existsSync(root)) throw new Error(`Knowledge base '${k}' does not exist. Run: squadrant knowledge init ${k}`);
    if (!o.fix) return { check: checkKbRepo(k, root) };
    const fix = fixKbRepo(k, root, { confirm: o.confirm && ((files) => o.confirm!(k, files)) });
    return { check: checkKbRepo(k, root), fix };
  });
}

export function renderKbDoctor(entries: KbDoctorEntry[]): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const { check: c, fix } of entries) {
    for (const f of fix?.fixed ?? []) lines.push(chalk.green(`  fixed ${c.kb}: ${f}`));
    for (const f of fix?.committed ?? []) lines.push(chalk.green(`  committed ${c.kb}: ${f}`));
    for (const w of fix?.warnings ?? []) lines.push(chalk.yellow(`  ! ${w}`));
    const problems = [
      ...(c.notRepo ? [`${c.root} is not a git repo`] : []),
      ...(c.missingIgnores.length ? [`.gitignore lacks ${c.missingIgnores.join(", ")}`] : []),
      ...(c.trackedNeverCommitted.length ? [`tracked but never committed (D7): ${c.trackedNeverCommitted.join(", ")}`] : []),
      ...(c.uncommitted.length ? [`uncommitted: ${c.uncommitted.join(", ")}`] : []),
    ];
    if (problems.length) ok = false;
    lines.push(problems.length ? chalk.red(`✘ ${c.kb}: ${problems.join("; ")}`) : chalk.green(`✔ ${c.kb}: clean`));
  }
  if (!ok) lines.push(chalk.dim("fix: squadrant knowledge doctor [kb] --fix (uncommitted item files are committed only after a y/n on a terminal, never from a crew session)"));
  return { lines, ok };
}

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
  const legacy = legacyIndexHint(kbDir(cfg, kb), kb);
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
  .description("Check each KB: repo clean (D7 .gitignore, nothing tracked that is never committed, no uncommitted files), items valid (D3/D4, common fields), index cache present, audit log healthy; --fix repairs the repo")
  .option("--fix", "ensure .gitignore and untrack never-committed files (commits that); asks before committing other uncommitted files")
  .action(async (kb: string | undefined, o: { fix?: boolean }) => {
    const repoKb = kb === USER_KB ? undefined : kb; // `_user` repo state: squadrant profile list --check
    const repo = kb !== USER_KB;
    const interactive = repo && !!o.fix && !!process.stdin.isTTY && !process.env.SQUADRANT_CREW_TASK_ID;
    let approved: Map<string, Set<string>> | undefined;
    if (interactive) {
      // Ask before fixing (fixKbRepo's confirm is synchronous): one y/n per KB; only the files shown are committed.
      approved = new Map();
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const e of runKbRepoDoctor(repoKb)) {
          if (!e.check.uncommitted.length) continue;
          console.log(`${e.check.kb}: changed outside a squadrant write:\n${e.check.uncommitted.map((f) => `  ${f}`).join("\n")}`);
          if ((await rl.question("commit them, one commit each (Approved-by: operator)? [y/N] ")).trim().toLowerCase() === "y") approved.set(e.check.kb, new Set(e.check.uncommitted));
        }
      } finally { rl.close(); }
    }
    const repoOut = repo
      ? renderKbDoctor(runKbRepoDoctor(repoKb, { fix: o.fix, confirm: approved && ((k, files) => files.every((f) => approved!.get(k)?.has(f))) }))
      : { lines: [], ok: true };
    for (const l of repoOut.lines) console.log(l);
    // Item/index/audit checks run after --fix, so the index.json hint reflects the repaired repo.
    const { checks, ok } = runKnowledgeDoctor(kb);
    const mark = { ok: chalk.green("✔"), fail: chalk.red("✘"), warn: chalk.yellow("!"), skip: chalk.dim("-") };
    for (const c of checks) console.log(`${mark[c.level]} ${c.message}`);
    console.log(ok && repoOut.ok ? chalk.green("healthy") : chalk.red("problems found"));
    if (!ok || !repoOut.ok) process.exitCode = 1;
  });
