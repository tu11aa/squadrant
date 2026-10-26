// crew-compact.ts — #1051: the CLI half of `squadrant crew compact`. The daemon owns the wait and
// the pane typing (core/daemon/crew-compact.ts); `crew send` calls waitForCrewCompact so a message
// sent while a compact is queued or running arrives after it, never inside its summary.
export type DaemonCall = (req: unknown) => Promise<unknown>;

export async function requestCrewCompact(project: string, crew: string, keep: string | undefined, call: DaemonCall): Promise<{ agent: string }> {
  const r = (await call({ kind: "crew-compact", project, crew, ...(keep ? { keep } : {}) })) as { agent?: string } | undefined;
  return { agent: r?.agent ?? "agent" };
}

/** Drop a queued compact (and the hold it puts on `crew send`); `cancelled: false` when none was queued. */
export async function cancelCrewCompact(project: string, crew: string, call: DaemonCall): Promise<{ cancelled: boolean }> {
  const r = (await call({ kind: "crew-compact-cancel", project, crew })) as { cancelled?: boolean } | undefined;
  return { cancelled: r?.cancelled === true };
}

/** Poll the daemon until no compact is queued/running for the crew. Throws if it outlasts `timeoutMs`. */
export async function waitForCrewCompact(
  project: string,
  crew: string,
  deps: { call: DaemonCall; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const deadline = Date.now() + (deps.timeoutMs ?? 14 * 60_000);
  let told = false;
  for (;;) {
    let holding = false;
    try { holding = ((await deps.call({ kind: "crew-compact-state", project, crew })) as { holding?: boolean } | undefined)?.holding === true; }
    catch { return; } // no daemon, no hold — never block a send on a probe failure
    if (!holding) return;
    if (!told) { deps.log?.(`crew ${crew} is compacting — waiting so your message lands after the compact`); told = true; }
    if (Date.now() > deadline) throw new Error(`Crew '${crew}' is still compacting after ${Math.round((deps.timeoutMs ?? 14 * 60_000) / 60_000)}m — message NOT sent; retry shortly.`);
    await sleep(pollMs);
  }
}
