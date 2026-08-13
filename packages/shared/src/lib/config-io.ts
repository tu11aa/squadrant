import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

let didLogMigration = false;
let migrationRun = false;

function tightenModeSync(p: string, expectedMode: number): void {
  try {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    const currentMode = stat.mode & 0o7777;
    if ((currentMode & ~expectedMode) !== 0) {
      fs.chmodSync(p, expectedMode);
      if (!didLogMigration) {
        console.warn(`\x1b[33m\u26A0\x1b[0m squadrant: tightened config file permissions (security fix #668)`);
        didLogMigration = true;
      }
    }
  } catch {
    // Ignore errors (e.g., EPERM)
  }
}

export function writeConfigFileSync(filePath: string, content: string): void {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  tightenModeSync(filePath, 0o600);
}

export function ensureDirSync(dirPath: string): void {
  if (dirPath !== CONFIG_DIR && !dirPath.startsWith(CONFIG_DIR + path.sep)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  
  let current = dirPath;
  while (current === CONFIG_DIR || current.startsWith(CONFIG_DIR + path.sep)) {
    tightenModeSync(current, 0o700);
    if (current === CONFIG_DIR) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function readConfigFileSync(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function migrateConfigPermsSync(): void {
  if (migrationRun) return;
  migrationRun = true;

  tightenModeSync(CONFIG_DIR, 0o700);
  tightenModeSync(path.join(CONFIG_DIR, "config.json"), 0o600);

  const projectsDir = path.join(CONFIG_DIR, "projects");
  tightenModeSync(projectsDir, 0o700);

  try {
    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          tightenModeSync(path.join(projectsDir, file), 0o600);
        }
      }
    }
  } catch {
    // Ignore
  }
}
