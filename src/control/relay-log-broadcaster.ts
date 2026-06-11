import { createServer, type Socket, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_SOCK_DIR = join(homedir(), ".config", "cockpit");

export function relayLogSockPath(project: string, sockDir?: string): string {
  return join(sockDir ?? DEFAULT_SOCK_DIR, `relay-${project}.sock`);
}

export async function createRelayLogBroadcaster(
  project: string,
  sockDir?: string,
): Promise<{
  log(m: string): void;
  close(): Promise<void>;
  sockPath: string;
}> {
  const sockPath = relayLogSockPath(project, sockDir);
  const clients = new Set<Socket>();

  // Remove stale socket file before listening (handles prior kill -9 leaving behind a dead socket).
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }

  const server: Server = createServer((conn) => {
    clients.add(conn);
    conn.on("error", () => clients.delete(conn));
    conn.on("close", () => clients.delete(conn));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  function log(m: string): void {
    const line = m.endsWith("\n") ? m : m + "\n";
    for (const client of clients) {
      try {
        client.write(line);
      } catch {
        clients.delete(client);
      }
    }
  }

  function close(): Promise<void> {
    for (const client of clients) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    return new Promise<void>((resolve) => {
      server.close(() => {
        try {
          if (existsSync(sockPath)) unlinkSync(sockPath);
        } catch {
          /* ignore */
        }
        resolve();
      });
    });
  }

  return { log, close, sockPath };
}
