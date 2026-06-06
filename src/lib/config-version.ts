import type { CockpitConfig } from "../config.js";

export function readStamp(config: CockpitConfig): string | null {
  return config._cockpitVersion ?? null;
}

export function needsCheck(config: CockpitConfig, pkgVersion: string): boolean {
  return readStamp(config) !== pkgVersion;
}

export function withStamp(config: CockpitConfig, pkgVersion: string): CockpitConfig {
  return { ...config, _cockpitVersion: pkgVersion };
}
