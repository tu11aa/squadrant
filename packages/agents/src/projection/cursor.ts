import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  ProjectionEmitResult,
  ProjectionEmitter,
  ProjectionSource,
} from "@cockpit/shared";

function renderMdc(source: ProjectionSource): string {
  const skillSections = source.skills
    .map(
      (s) =>
        `## Skill: ${s.name}\n\n*${s.description}*\n\n${s.content}`,
    )
    .join("\n\n");

  const body = [source.instructions.trim(), skillSections]
    .filter((s) => s.length > 0)
    .join("\n\n");

  const frontmatter = [
    "---",
    "description: Cockpit-projected rules and skills",
    "globs: ['**/*']",
    "alwaysApply: true",
    "---",
    "",
  ].join("\n");

  return `${frontmatter}${body}\n`;
}

async function readExisting(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

function buildDiff(existing: string | null, generated: string): string {
  if (existing === null) return `NEW FILE\n---\n${generated}`;
  if (existing === generated) return "UNCHANGED";
  return `OVERWRITE\n--- old\n${existing}\n--- new\n${generated}`;
}

export function createCursorEmitter(): ProjectionEmitter {
  return {
    name: "cursor",

    destinations(scope, projectRoot) {
      if (scope === "user") {
        return [
          {
            path: path.join(os.homedir(), ".cursor/rules/cockpit-global.mdc"),
            shared: false,
            format: "mdc",
          },
        ];
      }
      if (!projectRoot) return [];
      return [
        {
          path: path.join(projectRoot, ".cursor/rules/cockpit.mdc"),
          shared: false,
          format: "mdc",
        },
      ];
    },

    async emit(source, dest, opts): Promise<ProjectionEmitResult> {
      const generated = renderMdc(source);
      const existing = await readExisting(dest.path);

      if (opts?.dryRun) {
        return {
          written: false,
          path: dest.path,
          bytesWritten: 0,
          diff: buildDiff(existing, generated),
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
