import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  WorkspaceDriver,
  WorkspaceProbeResult,
  WorkspaceScope,
} from "@cockpit/shared";

// Rejects `../` escapes and absolute paths via lexical containment check.
// Does NOT resolve symlinks — a symlink inside the vault pointing outside
// will be followed by fs.* calls. Vault contents are trusted in the cockpit
// threat model (user-owned, not untrusted input). Tracked in issue #25.
function resolveInRoot(root: string, relative: string): string {
  const joined = path.resolve(root, relative);
  const normalized = path.resolve(root) + path.sep;
  if (joined !== path.resolve(root) && !joined.startsWith(normalized)) {
    throw new Error(`Path '${relative}' escapes workspace root`);
  }
  return joined;
}

export function createObsidianDriver(scope: WorkspaceScope): WorkspaceDriver {
  const root = scope.root;
  if (typeof root !== "string" || root === "") {
    throw new Error("ObsidianDriver requires scope.root (string)");
  }

  return {
    name: "obsidian",

    async probe(): Promise<WorkspaceProbeResult> {
      return {
        installed: true,
        rootExists: existsSync(root),
      };
    },

    async read(rel: string): Promise<string> {
      return fs.readFile(resolveInRoot(root, rel), "utf-8");
    },

    async write(rel: string, content: string): Promise<void> {
      const abs = resolveInRoot(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },

    async exists(rel: string): Promise<boolean> {
      try {
        await fs.access(resolveInRoot(root, rel));
        return true;
      } catch {
        return false;
      }
    },

    async list(rel: string): Promise<string[]> {
      try {
        return await fs.readdir(resolveInRoot(root, rel));
      } catch {
        return [];
      }
    },

    async mkdir(rel: string): Promise<void> {
      await fs.mkdir(resolveInRoot(root, rel), { recursive: true });
    },
  };
}
