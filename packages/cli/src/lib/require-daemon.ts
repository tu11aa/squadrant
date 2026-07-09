import { isDaemonSocketLive } from "@squadrant/core";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_SOCK_PATH = join(homedir(), ".config", "squadrant", "squadrant.sock");

export async function requireDaemon(sockPath: string = DEFAULT_SOCK_PATH): Promise<void> {
  const isLive = await isDaemonSocketLive(sockPath);
  if (!isLive) {
    throw new Error("daemon not running — message NOT delivered. Start it with 'squadrant launch <project>'.");
  }
}
