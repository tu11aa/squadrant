import type { SquadrantConfig } from "../config.js";

export function readStamp(config: SquadrantConfig): string | null {
  return config._squadrantVersion ?? null;
}

export function needsCheck(config: SquadrantConfig, pkgVersion: string): boolean {
  return readStamp(config) !== pkgVersion;
}

export function withStamp(config: SquadrantConfig, pkgVersion: string): SquadrantConfig {
  return { ...config, _squadrantVersion: pkgVersion };
}
