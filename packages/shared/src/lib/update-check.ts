import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SquadrantConfig } from "../config.js";

export interface UpdateCheckState {
  lastChecked?: number;
  latestKnown?: string;
}

export interface CheckForUpdateOutcome {
  notice: string | null;
  /** New state to persist, or null when nothing changed (opt-out / cache hit / fetch failure). */
  newState: UpdateCheckState | null;
}

export const UPDATE_CHECK_STATE_PATH = path.join(os.homedir(), ".config", "squadrant", "update-check.json");

const REGISTRY_URL = "https://registry.npmjs.org/squadrant/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

export function isUpdateCheckDisabled(
  config: Pick<SquadrantConfig, "defaults"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_UPDATE_NOTIFIER) return true;
  return config?.defaults?.updateCheck === false;
}

export function isCacheStale(state: UpdateCheckState | undefined, now: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!state?.lastChecked) return true;
  return now - state.lastChecked >= intervalMs;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export function formatUpdateNotice(latest: string, current: string): string {
  return `⬆ squadrant ${latest} available (you have ${current}) — npm i -g squadrant@latest`;
}

/**
 * Queries the npm registry directly (never the `npm view` CDN — see the v0.13.1 incident).
 * Never throws; races the request against its own timer so a bad network resolves to null
 * within timeoutMs even if the injected fetch implementation ignores the abort signal.
 */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });

  const request = (async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === "string" ? data.version : null;
    } catch {
      return null;
    }
  })();

  return Promise.race([request, timeout]);
}

/** Pure decision core: given cache state and injected fetch, decides whether to print a notice and what state to persist. No filesystem access. */
export async function checkForUpdate(opts: {
  currentVersion: string;
  state: UpdateCheckState | undefined;
  now: number;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<CheckForUpdateOutcome> {
  if (!isCacheStale(opts.state, opts.now, opts.intervalMs)) {
    const latest = opts.state?.latestKnown;
    const notice = latest && isNewerVersion(latest, opts.currentVersion) ? formatUpdateNotice(latest, opts.currentVersion) : null;
    return { notice, newState: null };
  }

  const latest = await fetchLatestVersion(opts.fetchImpl, opts.timeoutMs);
  if (!latest) return { notice: null, newState: null };

  const newState: UpdateCheckState = { lastChecked: opts.now, latestKnown: latest };
  const notice = isNewerVersion(latest, opts.currentVersion) ? formatUpdateNotice(latest, opts.currentVersion) : null;
  return { notice, newState };
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
 * all in one best-effort call that never throws and never blocks past fetchLatestVersion's timeout.
 */
export async function notifyIfUpdateAvailable(opts: {
  config: Pick<SquadrantConfig, "defaults"> | undefined;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
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
