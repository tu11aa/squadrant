const DAEMON_CACHED_PREFIXES = [
  "telegram.",
  "defaults.taskTimeoutMs",
  "defaults.cmuxEventsBridge",
  "defaults.router",
  "projects.",
];

export function isDaemonCachedKey(dottedKey: string): boolean {
  return DAEMON_CACHED_PREFIXES.some((p) => dottedKey === p || dottedKey.startsWith(p));
}

/**
 * Subset of the daemon-cached keys the daemon can apply live via `config-reload`
 * (no restart). `projects.*` qualifies because the daemon reads the project
 * registry through loadConfig() on demand; the one boot-time derivative (the
 * router's per-project tokens) is topped up by the reload. Everything else in
 * DAEMON_CACHED_PREFIXES is captured once at boot and still needs a restart.
 */
const DAEMON_LIVE_RELOAD_PREFIXES = ["projects."];

export function isDaemonLiveReloadableKey(dottedKey: string): boolean {
  return DAEMON_LIVE_RELOAD_PREFIXES.some((p) => dottedKey === p || dottedKey.startsWith(p));
}
