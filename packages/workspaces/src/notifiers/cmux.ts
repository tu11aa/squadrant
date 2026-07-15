import { execFile as execFileCb, execSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  NotifierDriver,
  NotifierProbeResult,
  NotifierScope,
} from "./types.js";
import { CMUX_TIMEOUT } from "../runtimes/cmux.js";

const execFile = promisify(execFileCb);

export function createCmuxNotifier(_scope: NotifierScope): NotifierDriver {
  return {
    name: "cmux",

    async probe(): Promise<NotifierProbeResult> {
      try {
        execSync("squadrant runtime status --command", { encoding: "utf-8", stdio: "pipe" });
        return { installed: true, reachable: true };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return { installed: false, reachable: false };
        }
        // Any non-ENOENT error: squadrant shim crashed, workspace down, or
        // config unreadable all collapse to "installed but not reachable".
        return { installed: true, reachable: false };
      }
    },

    async notify(message: string): Promise<void> {
      // execFile (async, NOT execFileSync) with an argv array and NO shell: the
      // message is one literal argv element, so backticks / $() in notification
      // text are never parsed by a shell (#120, same class as #118/#119). Async
      // is required, not stylistic — a caller running inside the daemon's own
      // event loop (the #579/#484 DELIVERY STUCK fault alert) would otherwise
      // block ALL projects' delivery/health/socket serving for up to
      // CMUX_TIMEOUT on every call.
      await execFile("squadrant", ["runtime", "send", "--command", message], { encoding: "utf-8", timeout: CMUX_TIMEOUT });
    },
  };
}
