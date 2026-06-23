const DAEMON_CACHED_PREFIXES = [
  "telegram.",
  "defaults.taskTimeoutMs",
  "defaults.cmuxEventsBridge",
  "projects.",
];

export function isDaemonCachedKey(dottedKey: string): boolean {
  return DAEMON_CACHED_PREFIXES.some((p) => dottedKey === p || dottedKey.startsWith(p));
}
