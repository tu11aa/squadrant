// packages/cli/src/__tests__/squadrantd-worktree-guard.test.ts
//
// #670 (live incident, reported mid-fix): a sibling crew ran
// `node dist/squadrantd.js &` from its own git worktree, and it bound the
// REAL production socket while the launchd-managed daemon happened to be
// down. Two gaps: (1) the rival was a worktree/dev checkout, not a second
// *installed* copy, so the #670-B plist-ownership guard (keyed off known
// package-manager install roots) never applies — it doesn't even run, since
// a direct `node dist/squadrantd.js` invocation bypasses ensureDaemon
// entirely. (2) the existing #360 isDaemonSocketLive check only refuses to
// steal a socket that's currently LIVE; it does nothing when the real daemon
// is down, which is exactly when this happened.
//
// isMonorepoCheckout is a structural check — independent of install-root
// pattern matching — that a published squadrant package (whose npm "files"
// are only dist/, plugin/, scripts/, templates/) will never satisfy, but any
// monorepo checkout (a fresh clone or ANY git worktree of it) always will,
// since a worktree carries the full working tree including packages/.
import { describe, it, expect } from "vitest";
import { isMonorepoCheckout, isLinkedWorktree } from "../squadrantd.js";
import { resolve, join } from "node:path";

describe("isMonorepoCheckout (#670)", () => {
  it("is true for a worktree checkout's compiled entry (packages/ sits next to dist/)", () => {
    const dirExists = (p: string) => p === "/Users/me/squadrant/.worktrees/foo/packages";
    expect(isMonorepoCheckout("/Users/me/squadrant/.worktrees/foo/dist/squadrantd.js", dirExists)).toBe(true);
  });

  it("is true for a worktree path given a RELATIVE argv regardless of cwd (#682)", () => {
    // If we pass a relative path like "dist/squadrantd.js", the resolve inside isMonorepoCheckout
    // uses process.cwd(). Since dirExists is mocked, we check if the passed path ends with "packages"
    // correctly derived from the resolved relative path.
    const relativeScript = "dist/squadrantd.js";
    const expectedPackagesPath = join(resolve(relativeScript), "..", "..", "packages");
    
    const dirExists = (p: string) => p === expectedPackagesPath;
    expect(isMonorepoCheckout(relativeScript, dirExists)).toBe(true);
  });

  it("is true for a plain (non-worktree) monorepo clone's compiled entry", () => {
    const dirExists = (p: string) => p === "/Users/me/squadrant/packages";
    expect(isMonorepoCheckout("/Users/me/squadrant/dist/squadrantd.js", dirExists)).toBe(true);
  });

  it("is false for a real pnpm global install (published files have no packages/ dir)", () => {
    const dirExists = () => false;
    expect(
      isMonorepoCheckout(
        "/Users/me/Library/pnpm/global/5/.pnpm/squadrant@0.18.0/node_modules/squadrant/dist/squadrantd.js",
        dirExists,
      ),
    ).toBe(false);
  });

  it("is false for a real npm global install", () => {
    const dirExists = () => false;
    expect(
      isMonorepoCheckout("/Users/me/.nvm/versions/node/v24.6.0/lib/node_modules/squadrant/dist/squadrantd.js", dirExists),
    ).toBe(false);
  });
});

// A LINKED worktree must never be allowed to become the production daemon (that
// is the 2026-08-18 incident), but the operator's own main checkout has been the
// standard dev-install topology here for months. The two are told apart
// structurally: `git worktree add` writes .git as a FILE ("gitdir: …"), a clone's
// .git is a DIRECTORY. Path naming is a convention and is deliberately not used.
describe("isLinkedWorktree (#682 follow-up — distinguish worktree from main checkout)", () => {
  it("is true when .git is a FILE (linked worktree)", () => {
    const statFile = (p: string) =>
      p.endsWith("/.git") ? { isFile: true } : undefined;
    expect(
      isLinkedWorktree("/Users/me/repo/.worktrees/crew-x/dist/squadrantd.js", statFile),
    ).toBe(true);
  });

  it("is false when .git is a DIRECTORY (main checkout — the operator's dev install)", () => {
    const statFile = (p: string) =>
      p.endsWith("/.git") ? { isFile: false } : undefined;
    expect(isLinkedWorktree("/Users/me/repo/dist/squadrantd.js", statFile)).toBe(false);
  });

  it("is false when .git is absent entirely (installed copy)", () => {
    const statFile = () => undefined;
    expect(
      isLinkedWorktree("/Users/me/Library/pnpm/global/5/node_modules/squadrant/dist/squadrantd.js", statFile),
    ).toBe(false);
  });

  it("does not rely on the path containing .worktrees", () => {
    // A worktree created anywhere must still be caught, and a main checkout that
    // merely lives under a directory called .worktrees must not be misclassified.
    const asFile = () => ({ isFile: true });
    const asDir = () => ({ isFile: false });
    expect(isLinkedWorktree("/tmp/somewhere/else/dist/squadrantd.js", asFile)).toBe(true);
    expect(isLinkedWorktree("/Users/me/.worktrees/main/dist/squadrantd.js", asDir)).toBe(false);
  });
});
