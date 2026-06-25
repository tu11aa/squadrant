import { describe, it, expect } from "vitest";
import { resolveCrewRoute } from "@squadrant/core";
import type { SquadrantConfig } from "@squadrant/shared";

function makeConfig(overrides?: Partial<SquadrantConfig["defaults"]>): SquadrantConfig {
  return {
    commandName: "command",
    hubVault: "~/hub",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "auto", captain: "auto" },
      crewRouting: {
        rules: [
          { tier: "extreme", match: "redesign|architect|rewrite", agent: "claude", model: "opus" },
          { tier: "hard", match: "refactor|implement|feature", agent: "claude", model: "sonnet" },
          { tier: "mobile", match: "mobile|ios|swift", agent: "codex" },
          { tier: "daily", match: "typo|docs|lint", agent: "opencode" },
        ],
      },
      ...overrides,
    },
    metrics: { enabled: false, path: "" },
  };
}

describe("resolveCrewRoute", () => {
  it("returns null when crewRouting is absent", () => {
    const config = makeConfig({ crewRouting: undefined });
    expect(resolveCrewRoute("refactor the auth module", config)).toBeNull();
  });

  it("returns null when rules array is empty", () => {
    const config = makeConfig({ crewRouting: { rules: [] } });
    expect(resolveCrewRoute("refactor the auth module", config)).toBeNull();
  });

  it("returns null when no rule matches", () => {
    const config = makeConfig();
    expect(resolveCrewRoute("update the README with examples", config)).toBeNull();
  });

  it("matches the extreme tier on 'redesign'", () => {
    const config = makeConfig();
    const result = resolveCrewRoute("redesign the auth system", config);
    expect(result).toMatchObject({ tier: "extreme", agent: "claude", model: "opus" });
  });

  it("matches the hard tier on 'refactor'", () => {
    const config = makeConfig();
    const result = resolveCrewRoute("refactor the daemon module", config);
    expect(result).toMatchObject({ tier: "hard", agent: "claude", model: "sonnet" });
  });

  it("first-match-wins: extreme rule fires before hard when both could match", () => {
    const config = makeConfig();
    // "rewrite" matches extreme; "implement" matches hard — extreme rule comes first
    const result = resolveCrewRoute("rewrite and implement the new api", config);
    expect(result?.tier).toBe("extreme");
  });

  it("matches are case-insensitive", () => {
    const config = makeConfig();
    expect(resolveCrewRoute("REFACTOR the auth module", config)).toMatchObject({ tier: "hard" });
    expect(resolveCrewRoute("Fix a TYPO in the readme", config)).toMatchObject({ tier: "daily" });
  });

  it("returns a rule without model when the rule omits model (mobile tier)", () => {
    const config = makeConfig();
    const result = resolveCrewRoute("mobile ios layout fixes", config);
    expect(result?.tier).toBe("mobile");
    expect(result?.agent).toBe("codex");
    expect(result?.model).toBeUndefined();
  });

  it("returns matchedRule with the original regex string", () => {
    const config = makeConfig();
    const result = resolveCrewRoute("implement a new login flow", config);
    expect(result?.matchedRule).toBe("refactor|implement|feature");
  });

  it("falls through to later rules when earlier rules don't match", () => {
    const config = makeConfig();
    const result = resolveCrewRoute("fix a typo in the readme", config);
    expect(result?.tier).toBe("daily");
    expect(result?.agent).toBe("opencode");
  });
});

// Regression: shipped default ruleset ordering (extreme → hard → mobile → daily)
import { getDefaultConfig } from "@squadrant/shared";

describe("resolveCrewRoute — shipped default config ordering", () => {
  it("'implement mobile feature' resolves to hard/claude/sonnet, not mobile/codex (hard rule precedes mobile in default ruleset)", () => {
    const config = getDefaultConfig();
    const result = resolveCrewRoute("implement mobile feature", config);
    expect(result).toMatchObject({ tier: "hard", agent: "claude", model: "sonnet" });
  });
});
