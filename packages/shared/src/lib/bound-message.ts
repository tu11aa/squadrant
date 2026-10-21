/** #1017: cap on crew-authored text relayed word-for-word to the captain. */
export const MAX_CREW_MESSAGE_CHARS = 1500;

/** Pure. Returns `text` trimmed, cut at `max` chars with a truncation marker. */
export function boundMessage(text: string, max: number = MAX_CREW_MESSAGE_CHARS): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}… [truncated, ${t.length - max} more chars]`;
}
