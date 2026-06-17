import type { WorkspaceDriver } from "@cockpit/shared";

export function createMemoryDriver(initial: Record<string, string> = {}): WorkspaceDriver & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();

  for (const key of files.keys()) {
    const parts = key.split("/");
    for (let i = 1; i <= parts.length - 1; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }

  return {
    name: "memory",
    files,

    async probe() {
      return { installed: true, rootExists: true };
    },

    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },

    async write(path, content) {
      files.set(path, content);
      const parts = path.split("/");
      for (let i = 1; i <= parts.length - 1; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    },

    async exists(path) {
      return files.has(path) || dirs.has(path);
    },

    async list(dir) {
      const prefix = dir === "" ? "" : `${dir}/`;
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first) entries.add(first);
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first && !rest.includes("/")) entries.add(first);
      }
      return Array.from(entries).sort();
    },

    async mkdir(path) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    },
  };
}
