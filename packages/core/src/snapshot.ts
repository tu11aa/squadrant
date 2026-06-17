// src/control/snapshot.ts
//
// PURE Tier 0/1/2 snapshot assembly (no I/O, no clock) for the read-only
// `snapshot` socket verb — the observability-dashboard counterpart to
// liveness.ts. Every derived value comes from already-gathered inputs + an
// explicit `now`, so the whole module is trivially unit-testable. cockpitd.ts
// performs the I/O (dist stat, log read, mailbox/store/results reads) and feeds
// the gathered numbers in here; this module never touches the filesystem.
import type { ComponentHealth } from "./liveness.js";
import type { MailboxStats } from "./mailbox.js";
export type { MailboxStats };

export type BuildState = "fresh" | "stale";

/**
 * Pure. The deploy-hygiene check: a daemon whose process started BEFORE the
 * current `dist/` build is running stale code (the recurring footgun). Fresh
 * requires the process to have started at or after the last build.
 *   processStartedAt >= distBuiltAt → "fresh"  (boundary inclusive)
 *   else                            → "stale"
 */
export function buildFreshness(processStartedAt: number, distBuiltAt: number): BuildState {
  return processStartedAt >= distBuiltAt ? "fresh" : "stale";
}

// ── Tier 0: daemon root ───────────────────────────────────────────────────────
export interface DaemonRoot {
  pid: number;
  uptimeMs: number;
  version: string;
  build: { state: BuildState; processStartedAt: number; distBuiltAt: number };
  /** lastSweepAt/ageMs are null until the first sweep has run. */
  sweep: { lastSweepAt: number | null; ageMs: number | null; cadenceMs: number };
  log: { errorCount: number; sizeBytes: number; windowMs: number };
}

// ── Tier 2: per-project data plane + global results ───────────────────────────

export interface DeliveryLag {
  maxSeq: number;
  lastAckedSeq: number;
  /** maxSeq − lastAckedSeq, clamped at 0 — "captain N behind". */
  behind: number;
}

export interface StoreStats {
  byState: Record<string, number>;
  corruptCount: number;
}

export interface ResultArtifacts {
  fileCount: number;
  totalBytes: number;
}

export interface ProjectDataPlane {
  project: string;
  mailbox: MailboxStats;
  delivery: DeliveryLag;
  store: StoreStats;
}

export interface DaemonSnapshot {
  tier0: DaemonRoot;
  /** Tier 1 — per-component liveness across all projects (reuses projectHealth). */
  tier1: ComponentHealth[];
  tier2: {
    projects: ProjectDataPlane[];
    /** _results/ is a single global directory keyed by task id. */
    results: ResultArtifacts;
  };
}

/** Already-gathered (I/O-resolved) inputs the pure assembler turns into a DaemonSnapshot. */
export interface DaemonSnapshotInputs {
  pid: number;
  processStartedAt: number;
  version: string;
  distBuiltAt: number;
  lastSweepAt: number | null;
  sweepCadenceMs: number;
  log: { errorCount: number; sizeBytes: number; windowMs: number };
  health: ComponentHealth[];
  projects: Array<{
    project: string;
    mailbox: MailboxStats;
    lastAckedSeq: number;
    storeByState: Record<string, number>;
    corruptCount: number;
  }>;
  results: ResultArtifacts;
}

/**
 * Pure. Derive the full DaemonSnapshot from gathered inputs and an explicit now.
 */
export function assembleDaemonSnapshot(input: DaemonSnapshotInputs, now: number): DaemonSnapshot {
  return {
    tier0: {
      pid: input.pid,
      uptimeMs: now - input.processStartedAt,
      version: input.version,
      build: {
        state: buildFreshness(input.processStartedAt, input.distBuiltAt),
        processStartedAt: input.processStartedAt,
        distBuiltAt: input.distBuiltAt,
      },
      sweep: {
        lastSweepAt: input.lastSweepAt,
        ageMs: input.lastSweepAt == null ? null : now - input.lastSweepAt,
        cadenceMs: input.sweepCadenceMs,
      },
      log: input.log,
    },
    tier1: input.health,
    tier2: {
      projects: input.projects.map((p) => ({
        project: p.project,
        mailbox: p.mailbox,
        delivery: {
          maxSeq: p.mailbox.maxSeq,
          lastAckedSeq: p.lastAckedSeq,
          behind: Math.max(0, p.mailbox.maxSeq - p.lastAckedSeq),
        },
        store: { byState: p.storeByState, corruptCount: p.corruptCount },
      })),
      results: input.results,
    },
  };
}
