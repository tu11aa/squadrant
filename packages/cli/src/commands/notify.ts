import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { createCmuxNotifier, NotifierRegistry } from "@squadrant/workspaces";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const notifyCommand = new Command("notify")
  .description("Send a message to the user via the configured notifier")
  .argument("<message>", "Message to send (use '-' to read from stdin)")
  .action(async (message: string) => {
    const config = loadConfig();
    const registry = new NotifierRegistry({ cmux: createCmuxNotifier });
    try {
      const payload = message === "-" ? await readStdin() : message;
      if (!payload) throw new Error("Empty message");
      await registry.get(config).notify(payload);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
