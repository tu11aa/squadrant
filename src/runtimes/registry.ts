import type { CockpitConfig } from "@cockpit/shared";
import type { RuntimeDriver, RuntimeProbeResult } from "./types.js";

const DEFAULT_RUNTIME = "cmux";

export class RuntimeRegistry {
  constructor(private drivers: Record<string, RuntimeDriver>) {}

  forProject(projectName: string, config: CockpitConfig): RuntimeDriver {
    const projectRuntime = config.projects[projectName]?.runtime;
    const runtimeName = projectRuntime ?? config.runtime ?? DEFAULT_RUNTIME;
    return this.get(runtimeName);
  }

  global(config: CockpitConfig): RuntimeDriver {
    const runtimeName = config.runtime ?? DEFAULT_RUNTIME;
    return this.get(runtimeName);
  }

  get(name: string): RuntimeDriver {
    const driver = this.drivers[name];
    if (!driver) {
      throw new Error(`Unknown runtime '${name}' — no driver registered`);
    }
    return driver;
  }

  async probeAll(): Promise<Record<string, RuntimeProbeResult>> {
    const results: Record<string, RuntimeProbeResult> = {};
    for (const [name, driver] of Object.entries(this.drivers)) {
      results[name] = await driver.probe();
    }
    return results;
  }
}
