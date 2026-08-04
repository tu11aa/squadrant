// The user's own work items — durable, cross-project, cross-session.
// NOT crew tasks (see TaskRecord in ./control.ts): no heartbeat, no
// auto-timeout. A work item may sit open for days; staleness is surfaced,
// never acted on. See docs/specs/2026-07-29-persisted-work-tracking.md §4.2.
export type WorkState = "working" | "blocked" | "paused" | "done" | "cancelled";

export const TERMINAL_WORK_STATES: ReadonlySet<WorkState> = new Set(["done", "cancelled"]);

export interface WorkItem {
  id: string;
  project: string;
  title: string;
  state: WorkState;
  /** The item this one nests under, or null. A wave is a parent; work inside
   *  it is a child (`--parent <wave-id>`); an incident with no parent sits
   *  flat at the top level — this is what lets waves finish out of order
   *  without the board becoming a lie (spec §4.3). */
  parent: string | null;
  tags: string[];
  note: string;
  crewTaskIds: string[];
  issue: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}
