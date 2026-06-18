// src/commands/health-view.ts
//
// Client + pure renderer for the daemon's #77 service-health surface. Shared by
// `cockpit doctor` and `cockpit status --detailed`. The query is a RAW socket
// call (never kickstarts the daemon); rendering is pure and unit-tested.
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { sendRequest, ageText } from "@cockpit/core";
export { ageText } from "@cockpit/core";
import type { ComponentHealth, HealthState } from "@cockpit/core";

const SOCK = join(homedir(), ".config", "cockpit", "cockpit.sock");

/**
 * Query the daemon for component liveness. Returns null when the daemon is
 * unreachable (the surface shows "daemon unreachable" rather than kickstarting
 * it). Optionally scoped to one project.
 */
export async function queryHealth(project?: string): Promise<ComponentHealth[] | null> {
  try {
    const reply = await sendRequest(SOCK, { kind: "health", project });
    return Array.isArray(reply) ? (reply as ComponentHealth[]) : [];
  } catch {
    return null;
  }
}

export function healthIcon(state: HealthState): string {
  switch (state) {
    case "alive": return "✔";
    case "stale": return "•";
    case "gone": return "✘";
    case "unknown": return "○";
  }
}

/** Color the state token without affecting the plain-text rendering used in tests. */
export function colorState(state: HealthState): string {
  switch (state) {
    case "alive": return chalk.green(state);
    case "stale": return chalk.yellow(state);
    case "gone": return chalk.red(state);
    case "unknown": return chalk.dim(state);
  }
}

/** Pure plain-text row (no color) — kept colorless so it is trivially testable. */
export function healthRow(c: ComponentHealth, now: number): string {
  const head = `${healthIcon(c.state)} ${c.kind.padEnd(8)} ${c.ref.padEnd(16)} ${c.state.padEnd(8)} ${ageText(c.lastSeenMs, now)}`;
  return c.detail ? `${head}  ${c.detail}` : head;
}

/**
 * Print the Service Health section to stdout (used by doctor + status --detailed).
 * Groups rows by project; flags the daemon being unreachable.
 */
export function printServiceHealth(rows: ComponentHealth[] | null, now: number = Date.now()): void {
  console.log(chalk.bold("\nService Health\n"));
  if (rows == null) {
    console.log(`  ${chalk.red("✘")} daemon unreachable — cockpit liveness is unknown (start the daemon)`);
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.dim("  no registered projects"));
    return;
  }
  const byProject = new Map<string, ComponentHealth[]>();
  for (const c of rows) {
    const list = byProject.get(c.project) ?? [];
    list.push(c);
    byProject.set(c.project, list);
  }
  for (const [project, comps] of byProject) {
    console.log(`  ${chalk.cyan(project)}`);
    for (const c of comps) {
      // Reuse the pure row for layout; recolor the state token in place.
      const plain = healthRow(c, now);
      console.log(`    ${plain.replace(c.state, colorState(c.state))}`);
    }
  }
}
