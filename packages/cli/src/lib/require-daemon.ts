import { sendRequest } from "@squadrant/core";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_SOCK_PATH = join(homedir(), ".config", "squadrant", "squadrant.sock");

export async function requireDaemon(sockPath: string = DEFAULT_SOCK_PATH): Promise<void> {
  try {
    // Only check if the daemon is alive. We don't care about a specific project here.
    // The health endpoint responds even if project is omitted.
    // We set a very short timeout, as a local socket should be instant.
    await sendRequest(sockPath, { kind: "health" }, 2000);
  } catch (err: any) {
    // We only fail if it's genuinely down (e.g. ECONNREFUSED) or timed out.
    // If it threw some other error but it *is* a squadrant error (e.g. invalid response format),
    // the daemon might still be up, but standard ECONNREFUSED means it's down.
    if (err.code === "ECONNREFUSED" || err.code === "ENOENT" || err.message.includes("timeout")) {
      console.error("daemon not running — message NOT delivered. Start it with 'squadrant launch <project>'.");
      process.exit(1);
    }
  }
}
