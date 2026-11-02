import chalk from "chalk";

/**
 * R1 (#1098): a captain-bound message must not be lost because the daemon is down or the captain
 * workspace is not running. `check` is the reachability probe (requireDaemon + needRef); when it fails
 * with one of those two known "not running" errors, `queue` writes the message to the mailbox and this
 * returns true. Any other failure (a runtime or config fault) is rethrown, never hidden behind "queued".
 */
export async function queueIfCaptainUnreachable(check: () => Promise<unknown>, queue: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return false;
  } catch (e) {
    const msg = (e as Error).message;
    if (!/^daemon not running|is not running$/.test(msg.split(" — ")[0]!)) throw e;
    console.error(chalk.yellow(`${msg.split(" — ")[0]} — queued in the mailbox; it is delivered when the captain is back.`));
    await queue();
    return true;
  }
}
