// hook.ts — #1136: pre-push hook installer. Chains (never clobbers) an existing hook.
import fs from "node:fs";
import path from "node:path";
import { git } from "./evidence.js";

export type HookMode = "run" | "check";
const MARKER = "# squadrant-verify-hook";

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

  const cmd = mode === "run" ? "squadrant verify" : "squadrant verify --check";
  // git feeds the refs being pushed on stdin; verify steps must not eat it, so
  // save it and replay it to the chained hook.
  const script = [
    "#!/bin/sh",
    `${MARKER} (mode: ${mode})`,
    'in=$(mktemp) && cat > "$in"',
    'trap \'rm -f "$in"\' EXIT',
    `${cmd} --repo "$(git rev-parse --show-toplevel)" </dev/null || { echo "squadrant verify: push blocked" >&2; exit 1; }`,
    ...(chained ? [`if [ -x "${chained}" ]; then "${chained}" "$@" < "$in"; exit $?; fi`] : []),
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  return { hookPath, chained };
}
