import { describe, it, expect } from "vitest";
import { isAuthorized, isControlEnabled } from "./auth.js";
import type { TelegramConfig } from "@squadrant/shared";

const base: TelegramConfig = { supergroupId: -100, chats: [-100] };

describe("telegram auth", () => {
  it("control disabled when remoteControl is unset/false", () => {
    expect(isControlEnabled(base)).toBe(false);
    expect(isControlEnabled({ ...base, remoteControl: false })).toBe(false);
    expect(isControlEnabled({ ...base, remoteControl: true })).toBe(true);
  });
  it("fails closed when users[] is empty or undefined", () => {
    expect(isAuthorized(42, base)).toBe(false);
    expect(isAuthorized(42, { ...base, users: [] })).toBe(false);
  });
  it("authorizes only allowlisted user ids", () => {
    const cfg = { ...base, users: [42] };
    expect(isAuthorized(42, cfg)).toBe(true);
    expect(isAuthorized(99, cfg)).toBe(false);
    expect(isAuthorized(undefined, cfg)).toBe(false);
  });
});
