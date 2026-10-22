/** #1017: cap on crew-authored text relayed word-for-word to the captain. */
export const MAX_CREW_MESSAGE_CHARS = 1500;

/**
 * Pure. Captain-facing render of a stored mailbox message (#1030): the mailbox keeps
 * the full text; the captain gets at most `max` chars, then a pointer to read the rest.
 * This is the single place the cap is applied.
 */
export function boundForCaptain(text: string, project: string, seq: number, max: number = MAX_CREW_MESSAGE_CHARS): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}… full: squadrant crew msg ${project} ${seq}`;
}
