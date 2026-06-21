import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeWithMarkers } from "./marker.js";
import type {
  ProjectionEmitResult,
  ProjectionEmitter,
  ProjectionSource,
} from "@squadrant/shared";

function renderMarkdown(source: ProjectionSource): string {
  const skillSections = source.skills
    .map((s) => `## Skill: ${s.name}\n\n*${s.description}*\n\n${s.content}`)
    .join("\n\n");
  return [source.instructions.trim(), skillSections]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function readExisting(p: string): Promise<string | null> {
  try { return await readFile(p, "utf-8"); }
  catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export function createOpencodeEmitter(): ProjectionEmitter {
  return {
    name: "opencode",

    destinations(scope, projectRoot) {
      if (scope === "user") {
        return [{
          path: path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
          shared: true,
          format: "markdown",
        }];
      }
      if (!projectRoot) return [];
      return [{
        path: path.join(projectRoot, "AGENTS.md"),
        shared: true,
        format: "markdown",
      }];
    },

    async emit(source, dest, opts): Promise<ProjectionEmitResult> {
      const body = renderMarkdown(source);
      const existing = await readExisting(dest.path);
      const generated = mergeWithMarkers(existing, body);

      if (opts?.dryRun) {
        return {
          written: false,
          path: dest.path,
          bytesWritten: 0,
          diff: existing === generated ? "UNCHANGED" : `MERGE\n--- old\n${existing ?? ""}\n--- new\n${generated}`,
        };
      }

      await mkdir(path.dirname(dest.path), { recursive: true });
      await writeFile(dest.path, generated, "utf-8");

      return {
        written: true,
        path: dest.path,
        bytesWritten: Buffer.byteLength(generated, "utf-8"),
      };
    },
  };
}
