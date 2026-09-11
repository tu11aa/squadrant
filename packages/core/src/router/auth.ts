// packages/core/src/router/auth.ts
import { randomBytes } from "node:crypto";

/** 32 random bytes, base64url — high entropy, URL/header safe. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Extract the token from an `Authorization: Bearer <t>` header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the project for an inbound request, or null when unauthorized. */
export function resolveProject(tokens: Map<string, string>, header: string | undefined): string | null {
  const token = parseBearer(header);
  if (!token) return null;
  return tokens.get(token) ?? null;
}
