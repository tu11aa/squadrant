export const MARKER_START = "<!-- cockpit:start -->";
export const MARKER_END = "<!-- cockpit:end -->";

export function mergeWithMarkers(existing: string | null, generated: string): string {
  const body = generated.replace(/\s+$/, "");
  const block = `${MARKER_START}\n${body}\n${MARKER_END}\n`;

  if (!existing) return block;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx === -1 && endIdx === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${block}`;
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Corrupted cockpit markers — found only ${startIdx === -1 ? "end" : "start"} marker. ` +
      `Remove the stray marker or delete the file and re-run projection emit.`,
    );
  }

  if (endIdx < startIdx) {
    throw new Error(`Corrupted cockpit markers — end appears before start. Manual repair needed.`);
  }

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + MARKER_END.length);
  const trimmedAfter = after.startsWith("\n") ? after.slice(1) : after;
  return `${before}${block}${trimmedAfter}`;
}
