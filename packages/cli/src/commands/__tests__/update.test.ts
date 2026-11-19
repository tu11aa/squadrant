import { describe, it, expect, vi } from "vitest";
import type { ComponentHealth } from "@squadrant/core";
import { planUpdate, runUpdate, isGlobalInstall, type UpdateDeps } from "../update.js";

const GLOBAL = "/usr/local/lib/node_modules/squadrant/dist/index.js";
const DEV = "/Users/me/code/squadrant/dist/index.js";

const h = (kind: "crew" | "captain", project: string, ref: string, state: ComponentHealth["state"]): ComponentHealth =>
  ({ kind, project, ref, state, lastSeenMs: null });

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps & { lines: string[]; errs: string[]; ran: string[][] } {
  const lines: string[] = [];
  const errs: string[] = [];
  const ran: string[][] = [];
  return {
    modulePath: GLOBAL,
    current: "0.38.0",
    manager: "npm",
    fetchRelease: async () => ({ version: "0.39.0", level: "important", reason: "fix", minSafe: "0.38.5" }),
    health: async () => [],
    exec: (argv: string[]) => { ran.push(argv); return argv[1] === "--version" ? "0.39.0\n" : ""; },
    out: (l: string) => lines.push(l),
    err: (l: string) => errs.push(l),
    ...over,
    lines, errs, ran,
  } as never;
}

describe("planUpdate", () => {
  it("refuses a dev/linked/git checkout", () => {
    expect(isGlobalInstall(DEV)).toBe(false);
    expect(isGlobalInstall("/x/.pnpm/squadrant@0.38.0/node_modules/squadrant/dist/index.js")).toBe(true);
    const p = planUpdate({ modulePath: DEV, manager: "npm", liveCrews: [], force: true });
    expect(p).toMatchObject({ ok: false });
  });
  it("refuses with live crews unless --force", () => {
    expect(planUpdate({ modulePath: GLOBAL, manager: "npm", liveCrews: ["p/c1"], force: false })).toMatchObject({ ok: false });
    expect(planUpdate({ modulePath: GLOBAL, manager: "npm", liveCrews: ["p/c1"], force: true })).toMatchObject({ ok: true });
  });
  it("uses the detected manager and --to", () => {
    const p = planUpdate({ modulePath: GLOBAL, manager: "pnpm", to: "0.30.0", liveCrews: [], force: false });
    expect(p).toMatchObject({ ok: true, install: ["pnpm", "add", "-g", "squadrant@0.30.0"] });
  });
});

describe("runUpdate", () => {
  it("--check reports latest/level/reason/minSafe and runs nothing", async () => {
    const d = deps();
    expect(await runUpdate({ check: true }, d)).toBe(0);
    const text = d.lines.join("\n");
    expect(text).toMatch(/latest:\s+0.39.0/);
    expect(text).toMatch(/level:\s+important/);
    expect(text).toMatch(/reason:\s+fix/);
    expect(text).toMatch(/minSafe:\s+0.38.5\s+← you are BELOW/);
    expect(d.ran).toEqual([]);
  });

  it("--dry-run prints the three commands and runs none", async () => {
    const d = deps();
    expect(await runUpdate({ dryRun: true }, d)).toBe(0);
    expect(d.lines.join("\n")).toMatch(/npm i -g squadrant@latest[\s\S]*squadrant --version[\s\S]*squadrant heal daemon/);
    expect(d.ran).toEqual([]);
  });

  it("refuses with a live crew, and on a dev checkout", async () => {
    const crew = deps({ health: async () => [h("crew", "p", "c1", "alive")] });
    expect(await runUpdate({}, crew)).toBe(1);
    expect(crew.errs.join()).toMatch(/live crew/);
    expect(crew.ran).toEqual([]);
    const dev = deps({ modulePath: DEV });
    expect(await runUpdate({}, dev)).toBe(1);
    expect(dev.errs.join()).toMatch(/dev\/linked\/git/);
  });

  it("installs, verifies, heals, then lists live captains to relaunch", async () => {
    const d = deps({ health: async () => [h("captain", "alpha", "cap", "alive"), h("crew", "alpha", "old", "gone")] });
    expect(await runUpdate({}, d)).toBe(0);
    expect(d.ran).toEqual([["npm", "i", "-g", "squadrant@latest"], ["squadrant", "--version"], ["squadrant", "heal", "daemon"]]);
    expect(d.lines.join("\n")).toMatch(/\/squadrant:restart[\s\S]*alpha/);
  });

  it("does not heal the daemon when the installed version is not the expected one", async () => {
    const d = deps({ exec: vi.fn((argv: string[]) => (argv[1] === "--version" ? "0.38.0\n" : "")) });
    expect(await runUpdate({}, d)).toBe(1);
    expect(d.errs.join()).toMatch(/expected 0.39.0/);
    expect((d.exec as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0][1] === "heal")).toBe(false);
  });

  it("says already up to date before refusing on live crews", async () => {
    const d = deps({ current: "0.39.0", health: async () => [h("crew", "p", "c1", "alive")] });
    expect(await runUpdate({}, d)).toBe(0);
    expect(d.lines.join()).toMatch(/already up to date/);
    expect(d.errs).toEqual([]);
  });

  it("is a no-op when already current", async () => {
    const d = deps({ current: "0.39.0" });
    expect(await runUpdate({}, d)).toBe(0);
    expect(d.ran).toEqual([]);
  });
});
