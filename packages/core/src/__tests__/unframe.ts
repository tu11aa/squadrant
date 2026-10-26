// Test helper (#1029): delivery tests that assert on message content, not the sender header.
export function unframe(text: string): string {
  const m = text.match(/^📨 [^\n]*\n([\s\S]*)$/);
  return m ? m[1] : text;
}

import { expect } from "vitest";
/** Asymmetric matcher: a delivered text whose frame body is exactly `body`. */
export const framedBody = (body: string) => expect.stringMatching(new RegExp(`^📨 [^\\n]*\\n${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
