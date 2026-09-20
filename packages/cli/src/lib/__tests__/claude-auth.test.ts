import { describe, it, expect } from "vitest";
import { parseClaudeAuthStatus, detectClaudeAuth } from "../claude-auth.js";

describe("parseClaudeAuthStatus", () => {
  it("reads loggedIn=true with method/provider", () => {
    const raw = JSON.stringify({
      loggedIn: true,
      authMethod: "api_key",
      apiProvider: "firstParty",
    });
    expect(parseClaudeAuthStatus(raw)).toEqual({
      authenticated: true,
      method: "api_key",
      provider: "firstParty",
    });
  });

  it("reads loggedIn=false", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({
      authenticated: false,
    });
  });

  it("returns null for non-JSON / missing loggedIn", () => {
    expect(parseClaudeAuthStatus("not json")).toBeNull();
    expect(parseClaudeAuthStatus("{}")).toBeNull();
    expect(parseClaudeAuthStatus(JSON.stringify({ authMethod: "key" }))).toBeNull();
    expect(parseClaudeAuthStatus("")).toBeNull();
  });
});

describe("detectClaudeAuth", () => {
  it("reports authenticated when the probe says so", () => {
    const res = detectClaudeAuth({ run: () => JSON.stringify({ loggedIn: true }) });
    expect(res.authenticated).toBe(true);
  });

  it("degrades gracefully when the CLI is missing / errors", () => {
    const res = detectClaudeAuth({
      run: () => {
        throw new Error("command not found: claude");
      },
    });
    expect(res.authenticated).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("degrades gracefully on unparseable output", () => {
    const res = detectClaudeAuth({ run: () => "claude: not logged in" });
    expect(res.authenticated).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("never claims authentication from a partial object", () => {
    const res = detectClaudeAuth({ run: () => JSON.stringify({ user: "x" }) });
    expect(res.authenticated).toBe(false);
  });
});
