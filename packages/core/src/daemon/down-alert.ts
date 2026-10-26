// #744: the boot-gap "daemon was down" alert (sendDownAlert in start.ts) is
// generated once at boot and can sit queued in a captain mailbox for hours or
// days if the pane was unreachable — by the time it delivers, "was down for
// N min" reads as a CURRENT outage. Two pure, independently-testable pieces:
//   (a) formatDownAlertText — bakes the actual outage window (local time +
//       tz offset) into the text so it's self-describing regardless of when
//       it's read.
//   (b) staleAge — a generic-enough (but not general-purpose) check any
//       delivery caller can run against a mailbox entry's own `ts` (already
//       the entry's generatedAt — no new field needed) vs. the actual
//       delivery time, to flag a message that's gone stale in the mailbox.

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatTzOffset(d: Date): string {
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const hh = pad2(Math.floor(abs / 60));
  const mm = abs % 60;
  return mm === 0 ? `${sign}${hh}` : `${sign}${hh}:${pad2(mm)}`;
}

/** Builds the boot-gap alert text with the actual outage window baked in, e.g.
 *  "daemon was down 2026-09-02 23:16 → 2026-09-03 06:25 (+07), 429 min
 *  (last exit reason=SIGTERM)". Local time — the tz offset is what lets a
 *  reader place it days later without guessing the daemon host's zone. */
export function formatDownAlertText(opts: { startTs: string; endTs: string; minutes: number; reasonText: string }): string {
  const start = new Date(opts.startTs);
  const end = new Date(opts.endTs);
  return `⚠️ daemon was down ${formatLocalDateTime(start)} → ${formatLocalDateTime(end)} (${formatTzOffset(end)}), ${opts.minutes} min (last exit reason=${opts.reasonText})`;
}

/** How long after generation a mailbox entry may sit before delivery must
 *  flag it as stale rather than let it read as current. */
export const STALE_ALERT_THRESHOLD_MS = 60 * 60 * 1000;

/** Returns the age in two units (`1h 59m`, `1d 23h`) when `deliveredAtMs` is more than
 *  STALE_ALERT_THRESHOLD_MS after `generatedAtMs`, else null. Rendered as the header
 *  field `stale: <age>`. Pure — callers decide which entries/kinds this applies to. */
export function staleAge(generatedAtMs: number, deliveredAtMs: number): string | null {
  const ageMs = deliveredAtMs - generatedAtMs;
  if (ageMs <= STALE_ALERT_THRESHOLD_MS) return null;
  const minutes = Math.round(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
