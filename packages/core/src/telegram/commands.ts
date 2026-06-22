// Curated registry for the Telegram GENERAL command channel (#402). Pure logic:
// parses "/cmd args" into a squadrant CLI argv vector — never a shell string. No
// I/O, no execution (Task 5 wires argv → async execFile). Default-deny on
// /config set: only WRITABLE_CONFIG_KEYS may be written over Telegram, so secrets
// (botToken/users/chats/supergroupId) can never be set from the phone.
//
// argv tokens are verified against the real CLI (packages/cli/src/commands/):
//   status → `status`, projects → `projects list`, crews → `crew list <p>`,
//   launch → `launch <p>`, effort → `effort [mode]`, config → `config get|set`,
//   spawn → `crew spawn <p> <task>`.

export type ParsedCommand =
  | { kind: "ok"; name: string; argv: string[] }     // argv to pass to the squadrant CLI
  | { kind: "usage"; name: string; message: string } // known command, bad args
  | { kind: "unknown"; message: string }             // not in registry / not a slash command
  | { kind: "denied"; message: string };             // e.g. /config set on a protected key

/** Default-deny allowlist of config keys writable over Telegram (#321). Starts
 *  intentionally tiny; extend deliberately. Secrets are NEVER added here. */
export const WRITABLE_CONFIG_KEYS: readonly string[] = ["defaults.effort"];

const EFFORT_MODES = new Set(["max", "balance", "low"]);

interface Entry {
  /** Build the argv (or a usage/denied result) from the post-name token list. */
  build(args: string[]): ParsedCommand;
  usage: string;
}

function ok(name: string, argv: string[]): ParsedCommand {
  return { kind: "ok", name, argv };
}
function usage(name: string, message: string): ParsedCommand {
  return { kind: "usage", name, message };
}

const REGISTRY: Record<string, Entry> = {
  status: { usage: "/status", build: () => ok("status", ["status"]) },
  projects: { usage: "/projects", build: () => ok("projects", ["projects", "list"]) },
  crews: {
    usage: "/crews <project>",
    build: (a) => (a[0] ? ok("crews", ["crew", "list", a[0]]) : usage("crews", "usage: /crews <project>")),
  },
  launch: {
    usage: "/launch <project>",
    build: (a) => (a[0] ? ok("launch", ["launch", a[0]]) : usage("launch", "usage: /launch <project>")),
  },
  effort: {
    usage: "/effort [max|balance|low]",
    build: (a) => {
      if (a.length === 0) return ok("effort", ["effort"]);
      if (!EFFORT_MODES.has(a[0])) return usage("effort", "usage: /effort [max|balance|low]");
      return ok("effort", ["effort", a[0]]);
    },
  },
  config: {
    usage: "/config get <key> | /config set <key> <value>",
    build: (a) => {
      const sub = a[0];
      if (sub === "get") {
        const key = a[1];
        if (!key) return usage("config", "usage: /config get <key>");
        return ok("config", ["config", "get", key]);
      }
      if (sub === "set") {
        const key = a[1];
        const value = a.slice(2).join(" ");
        if (!key || value === "") return usage("config", "usage: /config set <key> <value>");
        if (!WRITABLE_CONFIG_KEYS.includes(key)) {
          return {
            kind: "denied",
            message: `⛔ '${key}' is not writable over Telegram. Allowed: ${WRITABLE_CONFIG_KEYS.join(", ")}`,
          };
        }
        return ok("config", ["config", "set", key, value]);
      }
      return usage("config", "usage: /config get <key> | /config set <key> <value>");
    },
  },
  spawn: {
    usage: "/spawn <project> <task...>",
    build: (a) => {
      const project = a[0];
      const task = a.slice(1).join(" ");
      if (!project || task === "") return usage("spawn", "usage: /spawn <project> <task...>");
      return ok("spawn", ["crew", "spawn", project, task]);
    },
  },
};

function helpText(): string {
  const lines = Object.values(REGISTRY).map((e) => `  ${e.usage}`);
  return ["Available commands:", ...lines, "  /help"].join("\n");
}

/** Parse a raw Telegram message into a curated command. Non-slash text and
 *  unregistered commands return `unknown`. */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "unknown", message: "unknown command — send /help" };
  }
  const tokens = trimmed.slice(1).split(/\s+/).filter((t) => t.length > 0);
  const name = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1);

  if (name === "help") {
    return { kind: "usage", name: "help", message: helpText() };
  }
  const entry = REGISTRY[name];
  if (!entry) {
    return { kind: "unknown", message: `unknown command '/${name}' — send /help` };
  }
  return entry.build(args);
}
