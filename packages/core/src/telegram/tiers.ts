// Crew notification tier → event-type membership. Tiers are cumulative:
// done_only ⊂ alert_only ⊂ all. See the layered-notification design.
import type { CrewTier } from "@squadrant/shared";

const DONE_ONLY = new Set(["task.done", "task.failed"]);
const ALERTS = new Set([
  ...DONE_ONLY,
  "task.blocked",
  "task.approval.requested",
  "task.input.requested",
  "task.timeout",
]);

export function tierIncludes(tier: CrewTier, eventType: string): boolean {
  switch (tier) {
    case "none": return false;
    case "done_only": return DONE_ONLY.has(eventType);
    case "alert_only": return ALERTS.has(eventType);
    case "all": return true;
  }
}
