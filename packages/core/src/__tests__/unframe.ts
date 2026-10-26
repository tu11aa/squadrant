// Test helper (#1029): delivery tests that assert on message content, not the sender frame.
export function unframe(text: string): string {
  const m = text.match(/^<squadrant-message [^>]*>\n([\s\S]*)\n<\/squadrant-message>$/);
  return m ? m[1] : text;
}

import { expect } from "vitest";
/** Asymmetric matcher: a delivered text whose frame body is exactly `body`. */
export const framedBody = (body: string) => expect.stringMatching(new RegExp(`^<squadrant-message [^>]*>\\n${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n</squadrant-message>$`));
