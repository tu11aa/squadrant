import { resolveHome, type CockpitConfig } from "@cockpit/shared";
import type {
  WorkspaceDriver,
  WorkspaceFactory,
  WorkspaceProbeResult,
} from "@cockpit/shared";

const DEFAULT_WORKSPACE = "obsidian";

export class WorkspaceRegistry {
  constructor(private factories: Record<string, WorkspaceFactory>) {}

  hub(config: CockpitConfig): WorkspaceDriver {
    const name = config.workspace ?? DEFAULT_WORKSPACE;
    return this.get(name)({ root: resolveHome(config.hubVault) });
  }

  forProject(projectName: string, config: CockpitConfig): WorkspaceDriver {
    const proj = config.projects[projectName];
    if (!proj) throw new Error(`Project '${projectName}' not found`);
    const name = proj.workspace ?? config.workspace ?? DEFAULT_WORKSPACE;
    return this.get(name)({ root: resolveHome(proj.spokeVault) });
  }

  get(name: string): WorkspaceFactory {
    const factory = this.factories[name];
    if (!factory) {
      throw new Error(`Unknown workspace provider '${name}' — no factory registered`);
    }
    return factory;
  }

  async probeAll(config: CockpitConfig): Promise<Record<string, WorkspaceProbeResult>> {
    const results: Record<string, WorkspaceProbeResult> = {};
    for (const [name, factory] of Object.entries(this.factories)) {
      const scope = { root: resolveHome(config.hubVault) };
      results[name] = await factory(scope).probe();
    }
    return results;
  }
}
