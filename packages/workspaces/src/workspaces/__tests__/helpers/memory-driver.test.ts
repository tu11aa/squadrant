import { describe, it, expect } from "vitest";
import { createMemoryDriver } from "./memory-driver.js";

describe("createMemoryDriver", () => {
  it("round-trips write/read", async () => {
    const d = createMemoryDriver();
    await d.write("a/b.md", "x");
    expect(await d.read("a/b.md")).toBe("x");
  });

  it("list returns immediate children only", async () => {
    const d = createMemoryDriver({ "a/b.md": "1", "a/c/d.md": "2" });
    expect((await d.list("a")).sort()).toEqual(["b.md", "c"]);
  });

  it("exists tracks both files and mkdir-created dirs", async () => {
    const d = createMemoryDriver();
    await d.mkdir("x/y");
    expect(await d.exists("x/y")).toBe(true);
    expect(await d.exists("x/z")).toBe(false);
  });
});
