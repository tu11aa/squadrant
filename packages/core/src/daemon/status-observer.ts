// #1112 P1 (status file): turns facts (tick gaps, probe errors, turn failures, healthy
// events) into conditions and incidents, and persists them under <stateRoot>/status/.
// It only RECORDS. It never sends a message or suppresses one (no notifier, no
// inhibition: `inhibitedBy` is a field, nothing reads it yet).
//
//   status/current.json     atomic snapshot (tmp + rename)
//   status/incidents.jsonl  append-only open/close log, rotated at 1 MB (one previous file)
//   status/suspensions.json owned by the suspension clock; mirrored into current.json
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlEvent, TaskRecord } from "@squadrant/shared";
import { classifyProbeError } from "./interactive-probe.js";
import { createSuspensionClock, suspensionsPath, SUSPENSION_TICK_MS, type Suspension, type SuspensionClock, type TickResult } from "./suspensions.js";

export type CondStatus = "True" | "False" | "Unknown";

export interface Condition {
  subject: string;
  type: string;
  status: CondStatus;
  reason: string;
  message: string;
  /** Only changes when `status` changes. */
  lastTransitionTime: number;
  lastProbeAt: number;
  evidence: string[];
  /** Key of an open ancestor incident that explains this one. Recorded only. */
  inhibitedBy?: string;
}

export interface Incident {
  key: string;
  subject: string;
  condition: string;
  openedAt: number;
  closedAt?: number;
  reason: string;
  message: string;
  evidence: string[];
  inhibitedBy?: string;
  /** machine incidents: end of the last suspension gap (stable-awake clock starts here). */
  stableSince?: number;
  /** machine incidents: number of gaps (dark wakes included) folded into this incident. */
  gaps?: number;
}

export interface StatusSnapshot {
  schema: 1;
  updatedAt: number;
  daemon: { pid: number; lastTickWall: number; tickIntervalMs: number };
  suspensions: Suspension[];
  conditions: Condition[];
  incidents: Incident[];
}

export const STATUS_SCHEMA = 1 as const;
export const DEFAULT_STABLE_AWAKE_MS = 5 * 60 * 1000;
export const INCIDENT_LOG_MAX_BYTES = 1024 * 1024;
/** Two sessions with network errors inside this window open network.Reachable=False. */
export const NETWORK_WINDOW_MS = 10 * 60 * 1000;
/** current.json is rewritten at least this often (for daemon.lastTickWall). */
const FLUSH_EVERY_MS = 30_000;
const KEEP_CLOSED = 20;
const MAX_EVIDENCE = 5;

const MACHINE = "machine";
const NETWORK = "network";
const DAEMON = "squadrant:daemon";
const MACHINE_KEY = "machine:asleep";
const NETWORK_KEY = "network:unreachable";

export const sessionSubject = (project: string, id: string): string => `session:${project}/${id}`;
const sessionIdOf = (subject: string): string => subject.slice(subject.lastIndexOf("/") + 1);

export interface StatusObserverOpts {
  dir: string; // <stateRoot>/status
  suspensions: () => Suspension[];
  now?: () => number;
  log?: (m: string) => void;
  stableAwakeMs?: number;
  tickIntervalMs?: number;
}

export interface StatusObserver {
  /** Feed every clock tick (gap detection must already have run). */
  tick(r: TickResult): void;
  /** A suspension learned outside a tick (boot gap that the OS confirms as sleep). */
  noteSuspension(s: Suspension): void;
  /** Live crew sessions; drops conditions for sessions that are gone. */
  syncSessions(live: { project: string; id: string }[]): void;
  sessionError(project: string, id: string, cls: string, source: string, text: string): void;
  sessionHealthy(project: string, id: string): void;
  snapshot(): StatusSnapshot;
  flush(force?: boolean): void;
}

export function createStatusObserver(opts: StatusObserverOpts): StatusObserver {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const stableAwakeMs = opts.stableAwakeMs ?? DEFAULT_STABLE_AWAKE_MS;
  const tickIntervalMs = opts.tickIntervalMs ?? 5_000;
  const currentPath = join(opts.dir, "current.json");
  const logPath = join(opts.dir, "incidents.jsonl");
  const prevLogPath = `${logPath}.1`;

  const conds = new Map<string, Condition>(); // key: `${subject}.${type}`
  const open = new Map<string, Incident>();
  let closed: Incident[] = [];
  const netErrs = new Map<string, number>(); // subject -> last network error time
  const netSessions = new Set<string>(); // sessions behind an open network incident
  let lastTickWall = now();
  let lastWrite = 0;
  let dirty = true;

  const ck = (subject: string, type: string) => `${subject}.${type}`;

  function setCond(subject: string, type: string, status: CondStatus, reason: string, message: string, extra: Partial<Condition> = {}): Condition {
    const t = now();
    const prev = conds.get(ck(subject, type));
    const next: Condition = {
      subject, type, status, reason, message,
      lastTransitionTime: prev && prev.status === status ? prev.lastTransitionTime : t,
      lastProbeAt: t,
      evidence: extra.evidence ?? prev?.evidence ?? [],
      ...(extra.inhibitedBy ? { inhibitedBy: extra.inhibitedBy } : {}),
    };
    if (!prev || prev.status !== status || prev.reason !== reason || prev.inhibitedBy !== next.inhibitedBy) dirty = true;
    conds.set(ck(subject, type), next);
    return next;
  }

  // ── incident log ────────────────────────────────────────────────────────────
  function appendLog(event: "open" | "close", incident: Incident): void {
    try {
      mkdirSync(opts.dir, { recursive: true });
      let size = 0;
      try { size = statSync(logPath).size; } catch { /* no file yet */ }
      if (size >= INCIDENT_LOG_MAX_BYTES) {
        renameSync(logPath, prevLogPath);
        // Re-state what is still open so a rebuild never needs more than the last two files.
        for (const o of open.values()) if (o.key !== incident.key) appendFileSync(logPath, `${JSON.stringify({ ts: now(), event: "open", carried: true, incident: o })}\n`);
      }
      appendFileSync(logPath, `${JSON.stringify({ ts: now(), event, incident })}\n`);
    } catch (e) { log(`incident log append failed: ${(e as Error).message}`); }
  }

  function openIncident(inc: Incident): void {
    open.set(inc.key, inc);
    appendLog("open", inc);
    dirty = true;
  }

  function closeIncident(key: string, reason: string, message: string): void {
    const inc = open.get(key);
    if (!inc) return;
    open.delete(key);
    const done: Incident = { ...inc, closedAt: now(), reason, message };
    closed = [...closed, done].slice(-KEEP_CLOSED);
    appendLog("close", done);
    dirty = true;
  }

  // ── machine ─────────────────────────────────────────────────────────────────
  const machineDown = () => conds.get(ck(MACHINE, "Awake"))?.status === "False";
  const networkDown = () => conds.get(ck(NETWORK, "Reachable"))?.status === "False";
  const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

  function onSuspension(from: number, to: number): void {
    const inc = open.get(MACHINE_KEY);
    if (inc) {
      // Dark wake or another gap inside the same night: extend, never close/reopen.
      inc.stableSince = to;
      inc.gaps = (inc.gaps ?? 1) + 1;
      inc.message = `machine suspended since ${hhmm(inc.openedAt)} (${inc.gaps} gaps)`;
      setCond(MACHINE, "Awake", "False", "Suspended", inc.message, { evidence: [`${inc.gaps} gaps, last ended ${hhmm(to)}`] });
      dirty = true;
      return;
    }
    const message = `machine suspended since ${hhmm(from)}`;
    openIncident({ key: MACHINE_KEY, subject: MACHINE, condition: "Awake", openedAt: from, reason: "Suspended", message, evidence: [`gap ${hhmm(from)}-${hhmm(to)}`], stableSince: to, gaps: 1 });
    setCond(MACHINE, "Awake", "False", "Suspended", message, { evidence: [`gap ${hhmm(from)}-${hhmm(to)}`] });
  }

  function evaluateMachineClose(t: number): void {
    const inc = open.get(MACHINE_KEY);
    if (!inc) return;
    const since = inc.stableSince ?? t;
    if (t - since < stableAwakeMs) return;
    const message = `awake since ${hhmm(since)} (suspended ${hhmm(inc.openedAt)}-${hhmm(since)}, ${inc.gaps ?? 1} gaps)`;
    closeIncident(MACHINE_KEY, "StablyAwake", message);
    setCond(MACHINE, "Awake", "True", "StablyAwake", message, { evidence: [] });
  }

  // ── network ─────────────────────────────────────────────────────────────────
  function evaluateNetwork(t: number): void {
    for (const [s, at] of netErrs) if (t - at > NETWORK_WINDOW_MS && !netSessions.has(s)) netErrs.delete(s);
    if (networkDown()) {
      for (const s of netErrs.keys()) netSessions.add(s);
      return;
    }
    if (netErrs.size < 2) return;
    for (const s of netErrs.keys()) netSessions.add(s);
    const names = [...netSessions].join(", ");
    const message = `network errors from ${netSessions.size} sessions`;
    openIncident({ key: NETWORK_KEY, subject: NETWORK, condition: "Reachable", openedAt: t, reason: "NetworkErrors", message, evidence: [names.slice(0, 300)] });
    setCond(NETWORK, "Reachable", "False", "NetworkErrors", message, { evidence: [names.slice(0, 300)] });
    for (const s of netSessions) {
      const c = conds.get(ck(s, "Reachable"));
      if (c && c.status === "False" && !c.inhibitedBy) setCond(s, "Reachable", "False", c.reason, c.message, { evidence: c.evidence, inhibitedBy: NETWORK_KEY });
    }
  }

  function networkSessionHealthy(subject: string): void {
    netErrs.delete(subject);
    if (netSessions.delete(subject) && netSessions.size === 0 && networkDown()) {
      closeIncident(NETWORK_KEY, "Recovered", "sessions that failed are healthy again");
      setCond(NETWORK, "Reachable", "True", "Recovered", "sessions that failed are healthy again", { evidence: [] });
    }
  }

  // ── sessions ────────────────────────────────────────────────────────────────
  function closeSessionIncidents(subject: string, reason: string, message: string): void {
    const id = sessionIdOf(subject);
    for (const key of [...open.keys()]) if (key.startsWith(`crew:${id}:`)) closeIncident(key, reason, message);
  }

  function dropSession(subject: string): void {
    closeSessionIncidents(subject, "SessionEnded", "session is no longer live");
    conds.delete(ck(subject, "Reachable"));
    dirty = true;
    networkSessionHealthy(subject);
  }

  // ── persistence ─────────────────────────────────────────────────────────────
  function snapshot(): StatusSnapshot {
    return {
      schema: STATUS_SCHEMA,
      updatedAt: now(),
      daemon: { pid: process.pid, lastTickWall, tickIntervalMs },
      suspensions: opts.suspensions(),
      conditions: [...conds.values()],
      incidents: [...open.values(), ...closed],
    };
  }

  function flush(force = false): void {
    const t = now();
    if (!force && !dirty && t - lastWrite < FLUSH_EVERY_MS) return;
    try {
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(`${currentPath}.tmp`, JSON.stringify(snapshot()));
      renameSync(`${currentPath}.tmp`, currentPath);
      lastWrite = t;
      dirty = false;
    } catch (e) { log(`status write failed: ${(e as Error).message}`); }
  }

  function readLog(path: string): { event: string; incident: Incident }[] {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch { return []; }
    const out: { event: string; incident: Incident }[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if ((r.event === "open" || r.event === "close") && r.incident?.key) out.push(r);
      } catch { /* bad line: skipped, never fatal */ }
    }
    return out;
  }

  function seedDefaults(): void {
    const t = now();
    const put = (subject: string, type: string, status: CondStatus, reason: string, message: string) => {
      if (!conds.has(ck(subject, type))) conds.set(ck(subject, type), { subject, type, status, reason, message, lastTransitionTime: t, lastProbeAt: t, evidence: [] });
    };
    put(MACHINE, "Awake", "True", "NoSuspension", "no suspension seen");
    put(NETWORK, "Reachable", "True", "NoErrorsReported", "no network errors reported by sessions");
    put(DAEMON, "Healthy", "True", "Ticking", "daemon ticking");
  }

  function conditionFromIncident(inc: Incident): Condition {
    return { subject: inc.subject, type: inc.condition, status: "False", reason: inc.reason, message: inc.message, lastTransitionTime: inc.openedAt, lastProbeAt: inc.openedAt, evidence: inc.evidence, ...(inc.inhibitedBy ? { inhibitedBy: inc.inhibitedBy } : {}) };
  }

  function load(): void {
    let snap: StatusSnapshot | null = null;
    let fileExists = true;
    try {
      const parsed = JSON.parse(readFileSync(currentPath, "utf8")) as StatusSnapshot;
      if (parsed && parsed.schema === STATUS_SCHEMA && Array.isArray(parsed.conditions) && Array.isArray(parsed.incidents)) snap = parsed;
      else log("status/current.json has an unexpected shape — rebuilding from incidents.jsonl");
    } catch (e) {
      fileExists = (e as NodeJS.ErrnoException).code !== "ENOENT";
      if (fileExists) log("status/current.json is corrupt — rebuilding from incidents.jsonl");
    }
    if (snap) {
      for (const c of snap.conditions) conds.set(ck(c.subject, c.type), c);
      for (const i of snap.incidents) { if (i.closedAt == null) open.set(i.key, i); else closed.push(i); }
      closed = closed.slice(-KEEP_CLOSED);
    } else {
      const events = [...readLog(prevLogPath), ...readLog(logPath)];
      for (const e of events) {
        if (e.event === "open") open.set(e.incident.key, e.incident);
        else if (open.delete(e.incident.key)) closed.push(e.incident);
      }
      closed = closed.slice(-KEEP_CLOSED);
      for (const inc of open.values()) conds.set(ck(inc.subject, inc.condition), conditionFromIncident(inc));
      if (events.length) log(`status rebuilt from incident log: ${open.size} open incident(s)`);
    }
    for (const inc of open.values()) {
      if (inc.key === NETWORK_KEY) for (const s of inc.evidence.join(",").split(", ")) if (s.startsWith("session:")) netSessions.add(s);
    }
    seedDefaults();
    dirty = true;
  }

  load();

  return {
    tick(r) {
      const t = now();
      lastTickWall = t;
      if (r.kind === "suspension") onSuspension(r.from, r.to);
      else if (r.kind === "stall") {
        const secs = Math.round((r.to - r.from) / 1000);
        setCond(DAEMON, "Healthy", "False", "EventLoopStall", `event loop stalled ~${secs}s (no OS sleep in the window)`, { evidence: [`${hhmm(r.from)}-${hhmm(r.to)}`] });
      } else if (conds.get(ck(DAEMON, "Healthy"))?.status === "False") {
        setCond(DAEMON, "Healthy", "True", "Ticking", "daemon ticking");
      }
      // Gap detection above runs before the close evaluation, so a dark wake extends the incident.
      if (r.kind !== "suspension") evaluateMachineClose(t);
      evaluateNetwork(t);
      flush();
    },
    noteSuspension(s) {
      if (s.kind !== "sleep") return;
      onSuspension(s.from, s.to);
      flush();
    },
    syncSessions(live) {
      const liveSubjects = new Set(live.map((l) => sessionSubject(l.project, l.id)));
      for (const c of [...conds.values()]) {
        if (c.subject.startsWith("session:") && !liveSubjects.has(c.subject)) dropSession(c.subject);
      }
      for (const s of liveSubjects) {
        if (!conds.has(ck(s, "Reachable"))) conds.set(ck(s, "Reachable"), { subject: s, type: "Reachable", status: "Unknown", reason: "NoSignal", message: "no health signal yet", lastTransitionTime: now(), lastProbeAt: now(), evidence: [] });
        dirty = true;
      }
    },
    sessionError(project, id, cls, source, text) {
      const subject = sessionSubject(project, id);
      const t = now();
      if (cls === "network") netErrs.set(subject, t);
      const inhibitedBy = machineDown() ? MACHINE_KEY : (cls === "network" && networkDown() ? NETWORK_KEY : undefined);
      const prev = conds.get(ck(subject, "Reachable"));
      const evidence = [...(prev?.status === "False" ? prev.evidence : []), text.slice(0, 160)].slice(-MAX_EVIDENCE);
      const reason = `${source}:${cls}`;
      const message = `${source} reported a ${cls} error`;
      const key = `crew:${id}:${cls}`;
      if (!open.has(key)) openIncident({ key, subject, condition: "Reachable", openedAt: t, reason, message, evidence: [text.slice(0, 160)], ...(inhibitedBy ? { inhibitedBy } : {}) });
      setCond(subject, "Reachable", "False", reason, message, { evidence, inhibitedBy });
      evaluateNetwork(t);
      flush();
    },
    sessionHealthy(project, id) {
      const subject = sessionSubject(project, id);
      const prev = conds.get(ck(subject, "Reachable"));
      if (prev?.status === "True") return; // heartbeats are frequent; nothing changes
      if (prev?.status === "False") closeSessionIncidents(subject, "Recovered", "next healthy event");
      setCond(subject, "Reachable", "True", "Healthy", "healthy event received", { evidence: [] });
      networkSessionHealthy(subject);
      flush();
    },
    snapshot,
    flush,
  };
}

const HEALTHY_EVENTS: ReadonlySet<string> = new Set(["heartbeat", "task.progress", "task.turn.started", "task.turn.completed", "task.delta"]);

/** Maps one applied control event onto session facts. Pure routing; the observer decides. */
export function feedEvent(obs: StatusObserver, rec: TaskRecord, event: ControlEvent): void {
  if (event.type === "task.turn.failed") {
    const err = (event as { error?: string }).error ?? "";
    const cls = classifyProbeError(err);
    obs.sessionError(rec.project, rec.id, cls === "retrying" ? "other" : cls, "turn.failed", err);
  } else if (HEALTHY_EVENTS.has(event.type)) {
    obs.sessionHealthy(rec.project, rec.id);
  }
}

export interface StatusRuntime {
  clock: SuspensionClock;
  observer: StatusObserver;
  /** Clock tick + observer tick. Gap detection always runs before the close evaluation. */
  tick(): void;
}

/** Builds the awake-time clock and the observer from the `status` config block.
 *  `enabled: false` returns undefined: no clock, no observer, budgets stay on wall time. */
export function createStatusRuntime(
  cfg: { enabled?: boolean; tickGapMs?: number; postWakeGraceMs?: number; stableAwakeMs?: number } | undefined,
  stateRoot: string,
  log?: (m: string) => void,
): StatusRuntime | undefined {
  if (cfg?.enabled === false) return undefined;
  const clock = createSuspensionClock({ path: suspensionsPath(stateRoot), log, tickGapMs: cfg?.tickGapMs, postWakeGraceMs: cfg?.postWakeGraceMs });
  const observer = createStatusObserver({ dir: join(stateRoot, "status"), suspensions: clock.list, log, stableAwakeMs: cfg?.stableAwakeMs, tickIntervalMs: SUSPENSION_TICK_MS });
  return { clock, observer, tick: () => observer.tick(clock.tick()) };
}
