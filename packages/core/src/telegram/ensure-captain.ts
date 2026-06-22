// Boot-if-down capability for Telegram auto-launch (#403). Mirrors the
// `group dispatch` warmup pattern (liveness probe → spawn `squadrant launch` →
// bounded warmup poll) but as an injectable factory: deps are stubbed in tests
// and wired from the daemon host (Task 5). The bridge stays decoupled from
// captain lifecycle — it only sees the returned `ensure(project)` closure.
//
// Debounce: concurrent calls for the same project share ONE launch + poll loop
// via an in-flight promise map, so a burst of inbound messages can't spawn N
// captains. The map entry clears on resolution (alive | launched | timeout).

export type EnsureResult = "alive" | "launched" | "timeout";

export interface EnsureCaptainDeps {
  isAlive: (project: string) => Promise<boolean>; // liveness probe
  launch: (project: string) => Promise<void>;     // spawn `squadrant launch <project>`
  warmupTimeoutMs?: number;                        // default 120_000
  pollMs?: number;                                 // default 1_000
  sleep?: (ms: number) => Promise<void>;           // injectable for tests
  now?: () => number;                              // injectable for tests
}

const DEFAULT_WARMUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createEnsureCaptainAlive(
  deps: EnsureCaptainDeps,
): (project: string) => Promise<EnsureResult> {
  const warmupTimeoutMs = deps.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  const inFlight = new Map<string, Promise<EnsureResult>>();

  async function run(project: string): Promise<EnsureResult> {
    if (await deps.isAlive(project)) return "alive";
    await deps.launch(project);
    const deadline = now() + warmupTimeoutMs;
    while (now() < deadline) {
      if (await deps.isAlive(project)) return "launched";
      await sleep(pollMs);
    }
    return "timeout";
  }

  return function ensure(project: string): Promise<EnsureResult> {
    // The guard is read+set synchronously (no await before set) so concurrent
    // callers for the same project provably share a single launch.
    const existing = inFlight.get(project);
    if (existing) return existing;
    const p = run(project).finally(() => inFlight.delete(project));
    inFlight.set(project, p);
    return p;
  };
}
