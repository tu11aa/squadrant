import { ROLE_REQUIREMENTS, type AgentCapability, type AgentDriver, type AgentProbeResult, type Role } from "./types.js";

export interface ValidationResult {
  allowed: boolean;
  missingRequired: AgentCapability[];
  missingPreferred: AgentCapability[];
  reason?: string;
}

export class CapabilityRegistry {
  private drivers: Record<string, AgentDriver>;
  private probeResults: Record<string, AgentProbeResult> = {};

  constructor(drivers: Record<string, AgentDriver>) {
    this.drivers = drivers;
  }

  async probeAll(): Promise<void> {
    for (const [name, driver] of Object.entries(this.drivers)) {
      this.probeResults[name] = await driver.probe();
    }
  }

  get(name: string): AgentDriver | undefined {
    return this.drivers[name];
  }

  getDriver(name: string): AgentDriver {
    const driver = this.drivers[name];
    if (!driver) {
      throw new Error(`No driver registered for agent '${name}'`);
    }
    return driver;
  }

  getProbeResult(name: string): AgentProbeResult | undefined {
    return this.probeResults[name];
  }

  validateRole(agent: string, role: Role): ValidationResult {
    const probe = this.probeResults[agent];
    if (!probe || !probe.installed) {
      return {
        allowed: false,
        missingRequired: [],
        missingPreferred: [],
        reason: `Agent '${agent}' is not installed`,
      };
    }

    const reqs = ROLE_REQUIREMENTS[role];
    const caps = new Set(probe.capabilities);

    const missingRequired = reqs.required.filter((c) => !caps.has(c));
    const missingPreferred = reqs.preferred.filter((c) => !caps.has(c));

    if (missingRequired.length > 0) {
      return {
        allowed: false,
        missingRequired,
        missingPreferred,
        reason: `${agent} cannot be ${role}: missing required capabilities [${missingRequired.join(", ")}]`,
      };
    }

    return { allowed: true, missingRequired: [], missingPreferred };
  }

  installedAgents(): string[] {
    return Object.entries(this.probeResults)
      .filter(([, probe]) => probe.installed)
      .map(([name]) => name);
  }
}
