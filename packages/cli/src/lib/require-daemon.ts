import { isDaemonSocketLive } from "@squadrant/core";
import { DAEMON_SOCK_PATH } from "@squadrant/shared";

export async function requireDaemon(sockPath: string = DAEMON_SOCK_PATH): Promise<void> {
  const isLive = await isDaemonSocketLive(sockPath);
  if (!isLive) {
    throw new Error("daemon not running — message NOT delivered. Start it with 'squadrant launch <project>'.");
  }
}
