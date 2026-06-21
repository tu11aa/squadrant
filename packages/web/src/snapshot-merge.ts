// src/dashboard/snapshot-merge.ts
//
// PURE merge of the two data sources behind the dashboard: the daemon's
// Tier 0/1/2 `DaemonSnapshot` (or "unreachable") and the dashboard process's
// Tier 3/4 `ExternalProbes`. The whole point of keeping this separate and pure
// is the degrade-never-blank guarantee: when the daemon is unreachable the
// external tiers still render, so a daemon outage never blanks the page.
import type { DaemonSnapshot } from "@squadrant/core";
import type { ExternalProbes } from "./probes.js";

export interface FullSnapshot {
  /** epoch ms this snapshot was assembled (drives "updated Ns ago"). */
  generatedAt: number;
  /** "unreachable" when the daemon socket query failed — Tier 0/1/2 are dark. */
  daemon: DaemonSnapshot | "unreachable";
  external: ExternalProbes;
}

/** Pure. Stamp the two sources into one FullSnapshot. */
export function mergeSnapshot(
  daemon: DaemonSnapshot | "unreachable",
  external: ExternalProbes,
  now: number,
): FullSnapshot {
  return { generatedAt: now, daemon, external };
}
