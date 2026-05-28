import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let _cached: string | undefined;

function resolveBin(): string {
  // 1. Env var override
  const envBin = process.env.COCKPIT_CMUX_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  // 2. Optional cmuxBin field in config.json
  try {
    const configPath = join(homedir(), ".config", "cockpit", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const cfgBin: unknown = cfg.cmuxBin;
      if (typeof cfgBin === "string" && existsSync(cfgBin)) return cfgBin;
    }
  } catch { /* config read is best-effort */ }

  // 3. PATH lookup
  try {
    const which = execFileSync("which", ["cmux"], { encoding: "utf-8" }).trim();
    if (which && existsSync(which)) return which;
  } catch { /* not on PATH */ }

  // 4. Fallback (backward compat for macOS .app install)
  return "/Applications/cmux.app/Contents/Resources/bin/cmux";
}

export function resolveCmuxBin(): string {
  return _cached ??= resolveBin();
}

export function resetCmuxBinCache(): void {
  _cached = undefined;
}
