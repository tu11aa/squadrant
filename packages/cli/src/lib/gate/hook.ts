// hook.ts — #1136: pre-push hook installer. Chains (never clobbers) an existing hook.
import fs from "node:fs";
import path from "node:path";
import { git } from "./evidence.js";

export type HookMode = "run" | "check";
const MARKER = "# squadrant-gate-hook";

export function installHook(repo: string, mode: HookMode): { hookPath: string; chained: string | null } {
  const hookPath = path.resolve(repo, git(repo, ["rev-parse", "--git-path", "hooks/pre-push"]));
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const chainedPath = `${hookPath}.pre-squadrant`;
  let chained: string | null = null;

  if (fs.existsSync(hookPath) && !fs.readFileSync(hookPath, "utf8").includes(MARKER)) {
    if (fs.existsSync(chainedPath)) {
      throw new Error(`${hookPath} is a foreign hook and ${chainedPath} already exists; resolve manually, refusing to clobber`);
    }
    fs.renameSync(hookPath, chainedPath);
  }
  if (fs.existsSync(chainedPath)) chained = chainedPath;

  const gateCmd = mode === "run" ? "squadrant gate --repo \"$(git rev-parse --show-toplevel)\"" : "squadrant gate --check --repo \"$(git rev-parse --show-toplevel)\"";
  const script = [
    "#!/bin/sh",
    `${MARKER} (mode: ${mode})`,
    `${gateCmd} || { echo "squadrant gate: push blocked" >&2; exit 1; }`,
    chained ? `[ -x "${chained}" ] && exec "${chained}" "$@"` : "",
    "exit 0",
    "",
  ].filter((l, i, a) => l !== "" || i === a.length - 1).join("\n");
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  return { hookPath, chained };
}
