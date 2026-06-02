import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveCodexModel } from "../config.js";

// All tests mock fs/promises so no real file I/O occurs.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";
const readFileMock = vi.mocked(readFile);

afterEach(() => { vi.resetAllMocks(); delete process.env["CODEX_HOME"]; });

describe("resolveCodexModel", () => {
  it("returns undefined when config file is missing", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(resolveCodexModel()).resolves.toBeUndefined();
  });

  it("returns the raw model when no migrations section exists", async () => {
    readFileMock.mockResolvedValue('model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n');
    await expect(resolveCodexModel()).resolves.toBe("gpt-5.5");
  });

  it("applies [notice.model_migrations] to the model", async () => {
    const toml = [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "medium"',
      "",
      "[notice.model_migrations]",
      '"gpt-5.3-codex" = "gpt-5.5"',
      "",
      "[tui.model_availability_nux]",
      '"gpt-5.5" = 4',
    ].join("\n");
    readFileMock.mockResolvedValue(toml);
    await expect(resolveCodexModel()).resolves.toBe("gpt-5.5");
  });

  it("applies migrations when the section is the last one in the file", async () => {
    const toml = [
      'model = "gpt-5.3-codex"',
      "",
      "[notice.model_migrations]",
      '"gpt-5.3-codex" = "gpt-5.5"',
      "",
    ].join("\n");
    readFileMock.mockResolvedValue(toml);
    await expect(resolveCodexModel()).resolves.toBe("gpt-5.5");
  });

  it("returns the model unchanged when it is not in the migrations map", async () => {
    const toml = [
      'model = "gpt-5.5"',
      "",
      "[notice.model_migrations]",
      '"gpt-5.3-codex" = "gpt-5.5"',
    ].join("\n");
    readFileMock.mockResolvedValue(toml);
    await expect(resolveCodexModel()).resolves.toBe("gpt-5.5");
  });

  it("returns undefined when config has no model key", async () => {
    readFileMock.mockResolvedValue('model_reasoning_effort = "medium"\n');
    await expect(resolveCodexModel()).resolves.toBeUndefined();
  });

  it("reads from CODEX_HOME when set", async () => {
    process.env["CODEX_HOME"] = "/custom/codex";
    readFileMock.mockResolvedValue('model = "gpt-5.5"\n');
    await resolveCodexModel();
    expect(readFileMock).toHaveBeenCalledWith("/custom/codex/config.toml", "utf8");
  });

  it("reads from ~/.codex/config.toml by default", async () => {
    readFileMock.mockResolvedValue('model = "gpt-5.5"\n');
    const { homedir } = await import("node:os");
    const expected = `${homedir()}/.codex/config.toml`;
    await resolveCodexModel();
    expect(readFileMock).toHaveBeenCalledWith(expected, "utf8");
  });
});
