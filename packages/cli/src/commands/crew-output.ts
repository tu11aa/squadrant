import type { TaskRecord } from "@squadrant/shared";
import type { ProjectUsage } from "@squadrant/core";

export function tailLines(
  text: string,
  maxLines = 40,
  maxBytes = 4096,
): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept = lines.slice(-maxLines);
  let result = kept.join("\n");
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    const truncated: string[] = [];
    let bytes = 0;
    for (const line of kept) {
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (bytes + lineBytes > maxBytes) break;
      truncated.push(line);
      bytes += lineBytes;
    }
    result = truncated.join("\n");
  }
  return result;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function reqLabel(n: number): string {
  return n === 1 ? "1 req" : `${n} reqs`;
}

/** U5: per-project routed cost, with a per-model breakdown sorted by cost desc. */
function formatUsageFooter(usage: ProjectUsage): string {
  const models = Object.entries(usage.models).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const lines = [`router: $${usage.costUsd.toFixed(4)} total · ${reqLabel(usage.requests)}`];
  for (const [name, m] of models) {
    lines.push(`  ${name}  $${m.costUsd.toFixed(4)} · ${reqLabel(m.requests)}`);
  }
  return lines.join("\n");
}

export function formatTaskLine(record: TaskRecord): string {
  const sid = shortId(record.id);
  const title = record.task
    .split("\n")[0]
    .slice(0, 60);
  return `${sid}  ${record.provider}  ${record.state}  ${record.lastEvent}  ${title}`;
}

export function filterTasks(
  records: TaskRecord[],
  opts: { id?: string; state?: string; stateOnly?: boolean },
): TaskRecord[] {
  let filtered = records;
  if (opts.id) {
    filtered = filtered.filter((r) => r.id.startsWith(opts.id!));
  }
  if (opts.state) {
    filtered = filtered.filter((r) => r.state === opts.state);
  }
  return filtered;
}

export function formatCompactTasks(
  records: TaskRecord[],
  opts: { compact?: boolean; stateOnly?: boolean; usage?: ProjectUsage },
): string {
  if (records.length === 0) {
    return "(no tasks match filter)";
  }
  if (opts.stateOnly) {
    return records[0].state;
  }
  if (opts.compact === false) {
    return JSON.stringify(records, null, 2);
  }
  const active = records.filter(r => !r.operatorHold);
  const held = records.filter(r => r.operatorHold);
  
  let out = "";
  if (active.length > 0) {
    if (held.length > 0) out += `active (${active.length}):\n`;
    out += active.map(r => (held.length > 0 ? "  " : "") + formatTaskLine(r)).join("\n");
  }
  if (held.length > 0) {
    if (out) out += "\n";
    out += `HELD BY OPERATOR (${held.length}) — not counted toward maxCrew:\n`;
    out += held.map(r => {
      const m = Math.round((Date.now() - r.operatorHold!.since) / 60000);
      const hm = m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
      const note = r.operatorHold!.note ? ` · "${r.operatorHold!.note}"` : "";
      return `  ${formatTaskLine(r)} · held ${hm}${note}`;
    }).join("\n");
  }
  if (opts.usage && opts.usage.requests > 0) {
    if (out) out += "\n";
    out += formatUsageFooter(opts.usage);
  }
  return out;
}
