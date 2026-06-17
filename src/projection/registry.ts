import type { ProjectionEmitter, ProjectionEmitterFactory } from "@cockpit/shared";

export class ProjectionRegistry {
  constructor(private factories: Record<string, ProjectionEmitterFactory>) {}

  get(name: string): ProjectionEmitter {
    const factory = this.factories[name];
    if (!factory) {
      const available = Object.keys(this.factories).join(", ") || "(none)";
      throw new Error(
        `Unknown projection target '${name}'. Available: ${available}.`,
      );
    }
    return factory();
  }

  list(): string[] {
    return Object.keys(this.factories);
  }
}
