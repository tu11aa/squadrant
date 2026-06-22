import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, getDefaultConfig, type SquadrantConfig, type TelegramConfig } from "../config.js";

function writeTempConfig(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sq-cfg-"));
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    const p = cleanups.pop()!;
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe("TelegramConfig", () => {
  it("round-trips a telegram block through loadConfig with all fields", () => {
    const telegram: TelegramConfig = {
      botToken: "123:abc",
      supergroupId: -1001234,
      chats: [-1001234, -1005678],
      pollMs: 2000,
    };
    const base = getDefaultConfig();
    const p = writeTempConfig({ ...base, telegram });
    cleanups.push(p);

    const loaded = loadConfig(p);
    expect(loaded.telegram).toEqual(telegram);
  });

  it("treats telegram as optional — a config with no telegram key is valid", () => {
    const base = getDefaultConfig();
    const p = writeTempConfig(base);
    cleanups.push(p);

    const loaded: SquadrantConfig = loadConfig(p);
    expect(loaded.telegram).toBeUndefined();
  });

  it("getDefaultConfig() does not include telegram", () => {
    expect(getDefaultConfig().telegram).toBeUndefined();
  });

  it("allows telegram with only the required fields (botToken/pollMs optional)", () => {
    const telegram: TelegramConfig = {
      supergroupId: -100999,
      chats: [-100999],
    };
    const base = getDefaultConfig();
    const p = writeTempConfig({ ...base, telegram });
    cleanups.push(p);

    const loaded = loadConfig(p);
    expect(loaded.telegram).toEqual(telegram);
    expect(loaded.telegram?.botToken).toBeUndefined();
    expect(loaded.telegram?.pollMs).toBeUndefined();
  });
});
