import type { CockpitConfig } from "@cockpit/shared";
import type {
  NotifierDriver,
  NotifierFactory,
  NotifierProbeResult,
} from "./types.js";

const DEFAULT_NOTIFIER = "cmux";

export class NotifierRegistry {
  constructor(private factories: Record<string, NotifierFactory>) {}

  get(config: CockpitConfig): NotifierDriver {
    const name = config.notifier ?? DEFAULT_NOTIFIER;
    return this.getFactory(name)({});
  }

  getFactory(name: string): NotifierFactory {
    const factory = this.factories[name];
    if (!factory) {
      throw new Error(`Unknown notifier provider '${name}' — no factory registered`);
    }
    return factory;
  }

  async probeAll(): Promise<Record<string, NotifierProbeResult>> {
    const results: Record<string, NotifierProbeResult> = {};
    for (const [name, factory] of Object.entries(this.factories)) {
      try {
        results[name] = await factory({}).probe();
      } catch {
        results[name] = { installed: false, reachable: false };
      }
    }
    return results;
  }
}
