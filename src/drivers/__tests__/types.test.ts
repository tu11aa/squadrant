import { describe, it, expect } from "vitest";
import { ROLE_REQUIREMENTS, type AgentDriver, type AgentCapability } from "../types.js";

describe("driver types", () => {
  it("defines requirements for all roles", () => {
    const roles = ["command", "captain", "crew", "exploration"] as const;
    for (const role of roles) {
      expect(ROLE_REQUIREMENTS[role]).toBeDefined();
      expect(ROLE_REQUIREMENTS[role].required).toBeInstanceOf(Array);
      expect(ROLE_REQUIREMENTS[role].preferred).toBeInstanceOf(Array);
    }
  });

  it("captain prefers teams", () => {
    expect(ROLE_REQUIREMENTS.captain.preferred).toContain("teams");
  });
});
