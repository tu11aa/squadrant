import { describe, it, expect } from "vitest";
import { isSqliteExperimentalWarning } from "../suppress-sqlite-warning.js";

describe("isSqliteExperimentalWarning", () => {
  it("matches only the SQLite ExperimentalWarning", () => {
    const sqlite = Object.assign(new Error("SQLite is an experimental feature and might change at any time"), { name: "ExperimentalWarning" });
    const other = Object.assign(new Error("Type Stripping is an experimental feature"), { name: "ExperimentalWarning" });
    const dep = Object.assign(new Error("SQLite is an experimental feature"), { name: "DeprecationWarning" });
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true);
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", "ExperimentalWarning")).toBe(true);
    expect(isSqliteExperimentalWarning(other)).toBe(false);
    expect(isSqliteExperimentalWarning(dep)).toBe(false);
  });
});
