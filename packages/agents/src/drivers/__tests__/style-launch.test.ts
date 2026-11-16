// #1129: both Claude launch paths pass the (possibly styled) role file through --append-system-prompt-file.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const styled = vi.fn((roleFile: string, _role: string) => roleFile);
vi.mock("@squadrant/core", () => ({ styledPromptFile: (f: string, r: string) => styled(f, r) }));

const { buildAgentCmd } = await import("../launch-cmd.js");
const { createClaudeDriver } = await import("../claude.js");
const { CapabilityRegistry } = await import("../registry.js");

describe("styled role prompt at launch", () => {
  it("captain launch uses the styled file in place of the template path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stylelaunch-"));
    fs.writeFileSync(path.join(dir, "captain.claude.md"), "# captain");
    styled.mockImplementation(() => "/gen/captain.claude.md");
    const r = new CapabilityRegistry({ claude: createClaudeDriver() } as never);
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, dir);
    expect(cmd).toContain("--append-system-prompt-file /gen/captain.claude.md");
    expect(styled).toHaveBeenCalledWith(path.join(dir, "captain.claude.md"), "captain");
  });
  it("crew launch passes role 'crew' and uses the styled file", () => {
    styled.mockImplementation(() => "/gen/crew.claude.md");
    const cmd = createClaudeDriver().buildCommand({ prompt: "x", workdir: "/w", role: "crew", promptFile: "/t/crew.claude.md" });
    expect(cmd).toContain("--append-system-prompt-file /gen/crew.claude.md");
    expect(styled).toHaveBeenCalledWith("/t/crew.claude.md", "crew");
  });
});
