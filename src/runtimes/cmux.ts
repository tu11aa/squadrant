import { execSync } from "node:child_process";
import type { RuntimeDriver, RuntimeProbeResult, RuntimeSpawnOptions, WorkspaceRef, PaneRef, RuntimePaneOptions } from "./types.js";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function cmux(args: string): string {
  return execSync(`"${CMUX_BIN}" ${args}`, { encoding: "utf-8" }).trim();
}

function parseList(output: string): WorkspaceRef[] {
  const refs: WorkspaceRef[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/(workspace:\d+)\s+(.+?)(?:\s+\(.*\))?(?:\s+\[selected\])?$/);
    if (match) {
      refs.push({
        id: match[1],
        name: match[2].trim(),
        status: "running",
      });
    }
  }
  return refs;
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"');
}

export function createCmuxDriver(): RuntimeDriver {
  return {
    name: "cmux",

    async probe(): Promise<RuntimeProbeResult> {
      try {
        const version = cmux("--version");
        return { installed: true, version };
      } catch {
        return { installed: false, version: "" };
      }
    },

    async list(): Promise<WorkspaceRef[]> {
      try {
        return parseList(cmux("list-workspaces"));
      } catch {
        return [];
      }
    },

    async status(nameOrId: string): Promise<WorkspaceRef | null> {
      const refs = await this.list();
      const hit = refs.find((r) => r.name === nameOrId || r.id === nameOrId);
      return hit ?? null;
    },

    async spawn(opts: RuntimeSpawnOptions): Promise<WorkspaceRef> {
      const cwdFlag = opts.workdir ? ` --cwd "${opts.workdir}"` : "";
      const output = cmux(`new-workspace --command "${escape(opts.command)}"${cwdFlag}`);
      const id = output.match(/workspace:\d+/)?.[0] || output.split(/\s+/).pop() || "";
      if (!id) {
        throw new Error(`cmux spawn did not return a workspace id: ${output}`);
      }
      cmux(`rename-workspace --workspace "${id}" "${escape(opts.name)}"`);
      if (opts.pinToTop) {
        try {
          cmux(`workspace-action --workspace "${id}" --action pin`);
        } catch { /* pin is best-effort */ }
      }
      return { id, name: opts.name, status: "running" };
    },

    async send(ref: string, message: string): Promise<void> {
      cmux(`send --workspace "${ref}" "${escape(message)}"`);
      cmux(`send-key --workspace "${ref}" Enter`);
    },

    async sendKey(ref: string, key: string): Promise<void> {
      cmux(`send-key --workspace "${ref}" ${key}`);
    },

    async readScreen(ref: string): Promise<string> {
      try {
        return cmux(`read-screen --workspace "${ref}"`);
      } catch {
        return "";
      }
    },

    async stop(ref: string): Promise<void> {
      try {
        cmux(`close-workspace --workspace "${ref}"`);
      } catch { /* may already be closed */ }
    },

    async newPane(opts: RuntimePaneOptions): Promise<PaneRef> {
      const titleArg = opts.title ? ` --title "${escape(opts.title)}"` : "";
      const output = cmux(`new-pane --type terminal --direction ${opts.direction} --workspace "${opts.workspaceId}"`);
      const surfaceId = output.match(/surface:\d+/)?.[0];
      if (!surfaceId) {
        throw new Error(`cmux new-pane did not return a surface id: ${output}`);
      }
      if (opts.title) {
        try {
          cmux(`rename-tab --workspace "${opts.workspaceId}" --surface "${surfaceId}"${titleArg}`);
        } catch { /* rename is best-effort */ }
      }
      return { workspaceId: opts.workspaceId, surfaceId };
    },

    async closePane(pane: PaneRef): Promise<void> {
      try {
        cmux(`close-surface --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}"`);
      } catch { /* may already be closed */ }
    },

    async sendToPane(pane: PaneRef, message: string): Promise<void> {
      cmux(`send --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}" "${escape(message)}"`);
      cmux(`send-key --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}" Enter`);
    },

    async readPaneScreen(pane: PaneRef): Promise<string> {
      try {
        return cmux(`read-screen --workspace "${pane.workspaceId}" --surface "${pane.surfaceId}"`);
      } catch {
        return "";
      }
    },
  };
}
