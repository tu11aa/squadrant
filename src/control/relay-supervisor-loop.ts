export interface RelaySupervisorDeps {
  bootRelay: () => Promise<() => void>;
  sleep: (ms: number) => Promise<void>;
  log: (m: string) => void;
  delayMs?: number;
  maxAttempts?: number;
  shouldContinue?: () => boolean;
}

export async function runRelaySupervisor(
  deps: RelaySupervisorDeps,
): Promise<(() => void) | undefined> {
  const delayMs = deps.delayMs ?? 3000;
  let attempt = 0;

  while (deps.shouldContinue?.() ?? true) {
    try {
      const stop = await deps.bootRelay();
      deps.log("relay booted");
      return stop;
    } catch (e) {
      attempt++;
      if (deps.maxAttempts != null && attempt >= deps.maxAttempts) {
        throw e;
      }
      deps.log(`relay boot failed, retrying in ${delayMs}ms`);
      await deps.sleep(delayMs);
    }
  }

  return undefined;
}
