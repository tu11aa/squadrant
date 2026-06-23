export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "status", description: "squadrant status" },
  { command: "projects", description: "list registered projects" },
  { command: "crews", description: "list crews for a project" },
  { command: "notify", description: "notifications: /notify crew <tier> | cap <on|off>" },
  { command: "mute", description: "mute a project's topic" },
  { command: "unmute", description: "unmute a project's topic" },
  { command: "help", description: "list commands" },
];
