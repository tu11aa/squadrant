// packages/core/src/knowledge/verdicts.ts — reviewer/operator verdicts, the future eval set (phase 2 D7, C5).
// Append-only and per machine, like the audit log: `<dir>/YYYY-MM.<machine>.jsonl`, never in the KB repo, so two
// machines never conflict on it. Scoring reads every machine's file it can see, plus the pre-phase-2 KB-root file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditMachineId, type AuditSink } from "./audit.js";

/** `SQUADRANT_VERDICTS_DIR` overrides the location (tests, relocated state). */
export const defaultVerdictsDir = () => process.env.SQUADRANT_VERDICTS_DIR || path.join(os.homedir(), ".local", "state", "squadrant", "verdicts");

/** Where verdicts lived before phase 2; still read for one version (fallback), never written. */
export const legacyVerdictsFile = (kbRoot: string) => path.join(kbRoot, "verdicts.jsonl");

const VERDICT_FILE_RE = /^\d{4}-\d{2}\..+\.jsonl$/;

/** Verdicts are the future eval set: append-only, never compacted. Never throws. */
export function appendVerdict(kb: string, v: Record<string, unknown>, now: Date, sink: Pick<AuditSink, "dir" | "machineId"> = {}): void {
  try {
    const dir = sink.dir ?? defaultVerdictsDir();
    fs.mkdirSync(dir, { recursive: true });
    const ts = now.toISOString();
    fs.appendFileSync(path.join(dir, `${ts.slice(0, 7)}.${sink.machineId ?? auditMachineId()}.jsonl`), JSON.stringify({ ts, kb, ...v }) + "\n");
  } catch (err) {
    console.error(`squadrant verdicts: write failed: ${(err as Error).message}`);
  }
}

const parse = (file: string): Record<string, unknown>[] => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
};

/** Every verdict for `kb`: all machines' files in the state dir, then the old `<kbRoot>/verdicts.jsonl`. */
export function readVerdicts(kb: string, kbRoot: string, dir = defaultVerdictsDir()): Record<string, unknown>[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((n) => VERDICT_FILE_RE.test(n)).sort(); } catch { /* none yet */ }
  return [...files.flatMap((f) => parse(path.join(dir, f)).filter((v) => v.kb === kb)), ...parse(legacyVerdictsFile(kbRoot))];
}
