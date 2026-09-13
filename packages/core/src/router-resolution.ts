import type { BackendMode, RouterConfig } from "@squadrant/shared";

/** U2 precedence: explicit flag > routing rule > role default > "native". Pure. */
export function resolveBackend(
  explicit: BackendMode | undefined,
  routeBackend: BackendMode | undefined,
  roleBackend: BackendMode | undefined,
): BackendMode {
  return explicit ?? routeBackend ?? roleBackend ?? "native";
}

/**
 * Reject an unusable backend selection before any spawn work happens:
 *  - `direct`/`proxy` speak the Anthropic Messages seam → claude-only.
 *  - `direct`/`proxy` need an upstream → defaults.router must be configured.
 * `native` is always usable.
 */
export function assertBackendUsable(o: { backend: BackendMode; agent: string; router: RouterConfig | undefined }): void {
  if (o.backend === "native") return;
  if (o.agent !== "claude") {
    throw new Error(`backend '${o.backend}' is claude-only; agent '${o.agent}' must use backend 'native'`);
  }
  if (!o.router) {
    throw new Error(`backend '${o.backend}' selected for agent 'claude' but defaults.router is not configured`);
  }
}

/** Daemon-boot gate: build the router service only when configured, and never under vitest. */
export function shouldBuildRouterService(router: RouterConfig | undefined, isVitest: boolean): boolean {
  return !!router && !isVitest;
}
