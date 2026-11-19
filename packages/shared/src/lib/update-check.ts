import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import type { SquadrantConfig } from "../config.js";

export interface UpdateCheckState {
  lastChecked?: number;
  latestKnown?: string;
  /** Set when the most recent check attempt failed (offline/timeout). Drives a shorter
   *  FAILURE_RETRY_MS backoff instead of the full 24h success interval, so an offline
   *  machine retries roughly hourly instead of hitting the registry on every invocation. */
  lastCheckFailed?: boolean;
  /** Release metadata from the registry's `squadrantUpdate` field, cached with latestKnown.
   *  Absent = normal. */
  level?: UpdateLevel;
  reason?: string;
  minSafe?: string;
}

export type UpdateLevel = "normal" | "important";

/** What a published release says about itself (root package.json `squadrantUpdate`). */
export interface ReleaseInfo {
  version: string;
  level: UpdateLevel;
  reason?: string;
  minSafe?: string;
}

export interface CheckForUpdateOutcome {
  notice: string | null;
  /** New state to persist, or null when nothing changed (opt-out / cache hit). */
  newState: UpdateCheckState | null;
}

export const UPDATE_CHECK_STATE_PATH = path.join(os.homedir(), ".config", "squadrant", "update-check.json");

const REGISTRY_URL = "https://registry.npmjs.org/squadrant/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

export type RegistryRequest = (url: string, timeoutMs: number) => Promise<unknown>;

/**
 * Fetches over node:https rather than global fetch(): a fetch() Promise exposes no
 * handle to detach from the event loop, so a pending request left ref'd would delay
 * process exit by up to timeoutMs on every single invocation of an offline machine.
 * http.ClientRequest itself has no unref() — the socket does, assigned asynchronously
 * via the 'socket' event — so we unref that once it's available. This is Node's
 * documented mechanism for exactly this: it lets the process exit immediately once
 * the CLI's own work is done, dropping the response if it arrives after. That's fine:
 * this check is a best-effort background notice, never something exit should wait on.
 */
const requestJson: RegistryRequest = (url, timeoutMs) =>
  new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": "squadrant-update-check" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("socket", (socket) => socket.unref());
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
  });

export function isUpdateCheckDisabled(
  config: Pick<SquadrantConfig, "defaults"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_UPDATE_NOTIFIER) return true;
  return config?.defaults?.updateCheck === false;
}

export function isCacheStale(
  state: UpdateCheckState | undefined,
  now: number,
  intervalMs = CHECK_INTERVAL_MS,
  failureIntervalMs = FAILURE_RETRY_MS,
): boolean {
  if (!state?.lastChecked) return true;
  return now - state.lastChecked >= (state.lastCheckFailed ? failureIntervalMs : intervalMs);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export type InstallManager = "npm" | "pnpm" | "yarn";

/**
 * Which package manager installed the copy of squadrant currently running,
 * inferred from the on-disk path of the running module (#670: the update
 * banner used to hardcode `npm i -g`, which silently creates a SECOND,
 * independent install when the real one is pnpm-managed — see the incident
 * writeup on issue #670). Falls back to npm when the path doesn't match a
 * known global-install layout.
 */
export function detectInstallManager(modulePath: string = import.meta.url): InstallManager {
  if (modulePath.includes("Library/pnpm/") || modulePath.includes("/pnpm/")) return "pnpm";
  if (modulePath.includes("/yarn/global/node_modules/")) return "yarn";
  return "npm";
}

/** argv for a global install of `squadrant@<spec>` with the given manager. */
export function installArgvFor(manager: InstallManager, spec: string): string[] {
  switch (manager) {
    case "pnpm": return ["pnpm", "add", "-g", `squadrant@${spec}`];
    case "yarn": return ["yarn", "global", "add", `squadrant@${spec}`];
    case "npm": return ["npm", "i", "-g", `squadrant@${spec}`];
  }
}

/** True when `current` is below the release's `minSafe` floor. */
export function isBelowMinSafe(current: string, minSafe: string | undefined): boolean {
  return !!minSafe && isNewerVersion(minSafe, current);
}

/** Parses the optional `squadrantUpdate` field of a registry document. Missing/invalid = normal. */
export function parseReleaseInfo(doc: unknown): ReleaseInfo | null {
  const d = doc as { version?: unknown; squadrantUpdate?: unknown } | null;
  if (typeof d?.version !== "string") return null;
  const meta = d.squadrantUpdate as { level?: unknown; reason?: unknown; minSafe?: unknown } | null | undefined;
  const info: ReleaseInfo = { version: d.version, level: "normal" };
  if (!meta || typeof meta !== "object") return info;
  if (meta.level === "important") info.level = "important";
  if (typeof meta.reason === "string" && meta.reason.trim()) info.reason = meta.reason.trim();
  if (typeof meta.minSafe === "string" && /^v?\d+\.\d+\.\d+/.test(meta.minSafe.trim())) info.minSafe = meta.minSafe.trim();
  return info;
}

export function formatUpdateNotice(
  latest: string,
  current: string,
  meta?: Pick<UpdateCheckState, "level" | "reason" | "minSafe">,
): string {
  const cmd = "run `squadrant update`";
  const because = meta?.reason ? ` — ${meta.reason}` : "";
  if (isBelowMinSafe(current, meta?.minSafe)) {
    return `⚠ squadrant ${current} is below the minimum safe version ${meta!.minSafe}${because}. Update now: ${cmd}`;
  }
  if (meta?.level === "important") {
    return `⚠ IMPORTANT: squadrant ${latest} available (you have ${current})${because}. Update soon: ${cmd}`;
  }
  return `⬆ squadrant ${latest} available (you have ${current}) — ${cmd}`;
}

/** The notice a cached state implies for `current`, or null. Pure; no network. */
export function noticeFromState(state: UpdateCheckState | undefined, current: string): string | null {
  const latest = state?.latestKnown;
  if (!latest) return null;
  if (!isNewerVersion(latest, current) && !isBelowMinSafe(current, state.minSafe)) return null;
  return formatUpdateNotice(latest, current, state);
}

/**
 * Queries the npm registry directly (never the `npm view` CDN — see the v0.13.1 incident).
 * Never throws. Races the request against its own unref'd timer, so the *logical* result
 * is always bounded by timeoutMs regardless of how requestFn behaves — real network
 * failures are additionally handled by requestJson's own req.unref()/setTimeout, which
 * guarantees the underlying resource can never hold the process open either.
 */
export async function fetchLatestRelease(
  requestFn: RegistryRequest = requestJson,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<ReleaseInfo | null> {
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });

  const request = (async (): Promise<ReleaseInfo | null> => {
    try {
      return parseReleaseInfo(await requestFn(REGISTRY_URL, timeoutMs));
    } catch {
      return null;
    }
  })();

  return Promise.race([request, timeout]);
}

export async function fetchLatestVersion(
  requestFn: RegistryRequest = requestJson,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  return (await fetchLatestRelease(requestFn, timeoutMs))?.version ?? null;
}

/** Pure decision core: given cache state and an injected request function, decides whether
 *  to print a notice and what state to persist. No filesystem access. */
export async function checkForUpdate(opts: {
  currentVersion: string;
  state: UpdateCheckState | undefined;
  now: number;
  fetchImpl?: RegistryRequest;
  intervalMs?: number;
  failureIntervalMs?: number;
  timeoutMs?: number;
}): Promise<CheckForUpdateOutcome> {
  if (!isCacheStale(opts.state, opts.now, opts.intervalMs, opts.failureIntervalMs)) {
    return { notice: noticeFromState(opts.state, opts.currentVersion), newState: null };
  }

  const release = await fetchLatestRelease(opts.fetchImpl, opts.timeoutMs);
  if (!release) return { notice: null, newState: { lastChecked: opts.now, lastCheckFailed: true } };

  const newState: UpdateCheckState = {
    lastChecked: opts.now,
    latestKnown: release.version,
    lastCheckFailed: false,
    ...(release.level === "important" ? { level: release.level } : {}),
    ...(release.reason ? { reason: release.reason } : {}),
    ...(release.minSafe ? { minSafe: release.minSafe } : {}),
  };
  return { notice: noticeFromState(newState, opts.currentVersion), newState };
}

/** Synchronous, cache-only notice (no network): for `--version`, doctor and status. Honors the opt-outs. */
export function cachedUpdateNotice(opts: {
  config: Pick<SquadrantConfig, "defaults"> | undefined;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  statePath?: string;
}): string | null {
  if (isUpdateCheckDisabled(opts.config, opts.env ?? process.env)) return null;
  return noticeFromState(readUpdateCheckState(opts.statePath), opts.currentVersion);
}

/** Cache-only: the below-minSafe warning, or null. For doctor/status. */
export function cachedMinSafeWarning(opts: Parameters<typeof cachedUpdateNotice>[0]): string | null {
  if (isUpdateCheckDisabled(opts.config, opts.env ?? process.env)) return null;
  const state = readUpdateCheckState(opts.statePath);
  return isBelowMinSafe(opts.currentVersion, state?.minSafe) ? noticeFromState(state, opts.currentVersion) : null;
}

export function readUpdateCheckState(statePath: string = UPDATE_CHECK_STATE_PATH): UpdateCheckState | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    return undefined;
  }
}

export function writeUpdateCheckState(state: UpdateCheckState, statePath: string = UPDATE_CHECK_STATE_PATH): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // best-effort cache; a failed write just means we check again next run
  }
}

/**
 * CLI entrypoint wiring: opt-out check, cache read, decision, cache write, notice print —
 * all in one best-effort call that never throws. Not awaiting this at the call site keeps
 * it off the command's own logic; the unref'd transport (see requestJson) and the bounded
 * race in fetchLatestVersion mean a pending check can't delay process exit either, and a
 * failed attempt is cached (see isCacheStale's failureIntervalMs) so an offline machine
 * doesn't retry the registry on every single invocation.
 */
export async function notifyIfUpdateAvailable(opts: {
  config: Pick<SquadrantConfig, "defaults"> | undefined;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: RegistryRequest;
  statePath?: string;
  readState?: (statePath: string) => UpdateCheckState | undefined;
  writeState?: (state: UpdateCheckState, statePath: string) => void;
  write?: (line: string) => void;
  now?: number;
}): Promise<void> {
  try {
    const env = opts.env ?? process.env;
    if (isUpdateCheckDisabled(opts.config, env)) return;

    const statePath = opts.statePath ?? UPDATE_CHECK_STATE_PATH;
    const readState = opts.readState ?? readUpdateCheckState;
    const writeState = opts.writeState ?? writeUpdateCheckState;
    const write = opts.write ?? ((line: string) => process.stderr.write(`\n${line}\n`));

    const outcome = await checkForUpdate({
      currentVersion: opts.currentVersion,
      state: readState(statePath),
      now: opts.now ?? Date.now(),
      fetchImpl: opts.fetchImpl,
    });

    if (outcome.newState) writeState(outcome.newState, statePath);
    if (outcome.notice) write(outcome.notice);
  } catch {
    // update notifications are best-effort and must never affect the CLI
  }
}
