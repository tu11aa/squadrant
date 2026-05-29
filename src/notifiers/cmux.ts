import { execFileSync, execSync } from "node:child_process";
import type {
  NotifierDriver,
  NotifierProbeResult,
  NotifierScope,
} from "./types.js";

export function createCmuxNotifier(_scope: NotifierScope): NotifierDriver {
  return {
    name: "cmux",

    async probe(): Promise<NotifierProbeResult> {
      try {
        execSync("cockpit runtime status --command", { encoding: "utf-8", stdio: "pipe" });
        return { installed: true, reachable: true };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return { installed: false, reachable: false };
        }
        // Any non-ENOENT error: cockpit shim crashed, workspace down, or
        // config unreadable all collapse to "installed but not reachable".
        return { installed: true, reachable: false };
      }
    },

    async notify(message: string): Promise<void> {
      // execFileSync with an argv array and NO shell: the message is one literal
      // argv element, so backticks / $() in notification text are never parsed
      // by a shell. See #120 (same class as #118/#119).
      execFileSync("cockpit", ["runtime", "send", "--command", message], { encoding: "utf-8" });
    },
  };
}
