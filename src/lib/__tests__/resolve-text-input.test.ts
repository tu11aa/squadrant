import { describe, it, expect } from "vitest";
import { resolveTextInput } from "../resolve-text-input.js";

describe("resolveTextInput", () => {
  describe("file precedence over positional", () => {
    it("reads from file when --task-file is provided, ignoring positional", async () => {
      const content = await resolveTextInput(
        { positional: "positional task", filePath: "/tmp/task.txt", label: "task" },
        { readFile: () => "file content" },
      );
      expect(content).toBe("file content");
    });

    it("reads from file when --message-file is provided, ignoring positional", async () => {
      const content = await resolveTextInput(
        { positional: "positional msg", filePath: "/tmp/msg.txt", label: "message" },
        { readFile: () => "message from file" },
      );
      expect(content).toBe("message from file");
    });
  });

  describe("stdin via '-'", () => {
    it("reads stdin when --task-file - is provided", async () => {
      const content = await resolveTextInput(
        { filePath: "-", label: "task" },
        { readStdin: async () => "stdin content with `backticks`" },
      );
      expect(content).toBe("stdin content with `backticks`");
    });

    it("reads stdin when --message-file - is provided", async () => {
      const content = await resolveTextInput(
        { filePath: "-", label: "message" },
        { readStdin: async () => "stdin `message`" },
      );
      expect(content).toBe("stdin `message`");
    });
  });

  describe("falls back to positional", () => {
    it("returns positional when no file option is provided", async () => {
      const content = await resolveTextInput(
        { positional: "positional task", label: "task" },
      );
      expect(content).toBe("positional task");
    });

    it("returns empty string positional when provided as positional", async () => {
      const content = await resolveTextInput(
        { positional: "", label: "task" },
      );
      expect(content).toBe("");
    });
  });

  describe("error cases", () => {
    it("throws with clear error when --task-file path does not exist", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      const readFile = () => { throw err; };

      await expect(
        resolveTextInput({ filePath: "/nonexistent/task.txt", label: "task" }, { readFile }),
      ).rejects.toThrow(/--task-file.*file not found/);
    });

    it("throws with clear error when --message-file path does not exist", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      const readFile = () => { throw err; };

      await expect(
        resolveTextInput({ filePath: "/nonexistent/msg.txt", label: "message" }, { readFile }),
      ).rejects.toThrow(/--message-file.*file not found/);
    });

    it("throws clear error when neither positional nor --task-file is provided", async () => {
      await expect(
        resolveTextInput({ label: "task" }),
      ).rejects.toThrow(/No task/);
    });

    it("throws clear error when neither positional nor --message-file is provided", async () => {
      await expect(
        resolveTextInput({ label: "message" }),
      ).rejects.toThrow(/No message/);
    });
  });

  describe("content preservation", () => {
    it("preserves backticks, quotes, and newlines verbatim from files", async () => {
      const content = await resolveTextInput(
        { filePath: "/tmp/special.txt", label: "task" },
        { readFile: () => "line one\nline two with `backticks`\nline three with \"quotes\"" },
      );
      expect(content).toBe("line one\nline two with `backticks`\nline three with \"quotes\"");
    });

    it("preserves backticks, quotes, and newlines verbatim from stdin", async () => {
      const content = await resolveTextInput(
        { filePath: "-", label: "message" },
        { readStdin: async () => "line one\nline two with `backticks`\nline three with \"quotes\"" },
      );
      expect(content).toBe("line one\nline two with `backticks`\nline three with \"quotes\"");
    });

    it("preserves multi-line shell-injection payload verbatim from files", async () => {
      const payload = "echo `id`\necho $(whoami)\necho \"nested '$HOME'\"";
      const content = await resolveTextInput(
        { filePath: "/tmp/payload.txt", label: "task" },
        { readFile: () => payload },
      );
      expect(content).toBe(payload);
    });
  });

  describe("real fs readFile (integration)", () => {
    it("reads an actual file from disk via default readFile", async () => {
      const { readFileSync } = await import("node:fs");
      const { mkdtempSync } = await import("node:fs");
      const { writeFileSync } = await import("node:fs");
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmp = mkdtempSync(join(tmpdir(), "resolve-test-"));
      try {
        const filePath = join(tmp, "input.txt");
        writeFileSync(filePath, "real file content with `backticks`");
        const content = await resolveTextInput(
          { filePath, label: "task" },
          { readFile: (p: string) => readFileSync(p, "utf8") },
        );
        expect(content).toBe("real file content with `backticks`");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
