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
import { isMonorepoCheckout } from "../squadrantd.js";
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
