import fs from "node:fs";

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function flagName(label: string): string {
  return label === "task" ? "--task-file" : "--message-file";
}

export interface ResolveTextInputOpts {
  positional?: string;
  filePath?: string;
  label: string;
}

export interface ResolveTextInputDeps {
  readFile?: (path: string) => string;
  readStdin?: () => Promise<string>;
}

export async function resolveTextInput(
  opts: ResolveTextInputOpts,
  deps?: ResolveTextInputDeps,
): Promise<string> {
  const readFile = deps?.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const readStdin = deps?.readStdin ?? readAllStdin;

  if (opts.filePath) {
    if (opts.filePath === "-") {
      return readStdin();
    }
    try {
      return readFile(opts.filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const flag = flagName(opts.label);
      if (err.code === "ENOENT") {
        throw new Error(`${flag} '${opts.filePath}': file not found`);
      }
      throw new Error(`${flag} '${opts.filePath}': ${err.message}`);
    }
  }

  if (opts.positional === undefined) {
    throw new Error(
      `No ${opts.label} provided. Provide a positional argument or use ${flagName(opts.label)}.`,
    );
  }

  return opts.positional;
}
