export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "status", description: "squadrant status" },
  { command: "projects", description: "list registered projects" },
  { command: "crews", description: "list crews for a project" },
  { command: "launch", description: "launch a project's captain" },
  { command: "effort", description: "set effort: max | balance | low" },
  { command: "spawn", description: "spawn a crew (guided)" },
  { command: "notify", description: "notification panel for a project topic" },
  { command: "mute", description: "mute a project's topic" },
  { command: "unmute", description: "unmute a project's topic" },
  { command: "help", description: "list commands" },
];
