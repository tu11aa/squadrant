export interface InteractiveHookAdapter {
  provider: string;
  tier: "strong" | "best-effort";
  /** Returns the env/flags/launch mutation needed to wire the hook. */
  injectHook(launchSpec: string[], hookCmd: string): string[];
}
