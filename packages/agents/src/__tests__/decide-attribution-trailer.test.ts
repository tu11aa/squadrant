import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAttributionTrailer, readAttributionDisabled } from "../interactive/claude.js";

const bash = (command: string, disabled = true) => decideAttributionTrailer("Bash", { command }, disabled);
const CLAUDE = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

describe("decideAttributionTrailer (#1007)", () => {
  it.each([
    ["Claude", "Co-Authored-By: Claude Opus 5.5 <noreply@claude.example>"],
    ["Anthropic email", "Co-Authored-By: Bot <noreply@anthropic.com>"],
    ["Codex", "co-authored-by: Codex <codex@x.dev>"],
    ["OpenAI", "Co-authored-by: ChatGPT <bot@openai.com>"],
    ["Gemini", "Co-Authored-By: Gemini <g@x.dev>"],
    ["opencode", "Co-Authored-By: opencode <o@x.dev>"],
  ])("denies a %s co-author trailer on git commit", (_n, line) => {
    const r = bash(`git commit -m "fix: x\n\n${line}"`);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(line);
  });

  it("denies a 'Generated with Claude Code' line", () => {
    const r = bash(`gh pr create --title t --body "done\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"`);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/Generated with/);
  });

  it("denies a heredoc-style commit message", () => {
    const r = bash(`git commit -m "$(cat <<'EOF'\nfix: x\n\n${CLAUDE}\nEOF\n)"`);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(CLAUDE);
  });

  it.each([
    "git commit --amend -m 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'",
    "git merge feat -m 'm\n\nCo-Authored-By: Claude <noreply@anthropic.com>'",
    "gh pr edit 3 --body 'Co-Authored-By: Claude <noreply@anthropic.com>'",
    "gh pr merge 3 --squash --body 'Co-Authored-By: Claude <noreply@anthropic.com>'",
  ])("denies on %s", (cmd) => {
    expect(bash(cmd).decision).toBe("deny");
  });

  it.each([
    `git rebase develop --exec "git commit --amend -m \\"$(git log -1 --format=%B | sed '/^Co-Authored-By: Claude/d')\\""`,
    `sed -i '/Co-Authored-By: Claude/d' msg.txt && git commit -F msg.txt`,
    `git commit --amend -m "$(git log -1 --format=%B | grep -v 'Co-Authored-By: Claude')"`,
    `git log --grep 'Co-Authored-By: Claude'`,
  ])("allows commands that remove the trailer: %s", (cmd) => {
    expect(bash(cmd).decision).toBe("allow");
  });

  it("denies a trailer after a literal \\n escape", () => {
    expect(bash(`git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"`).decision).toBe("deny");
  });

  it("allows a human co-author", () => {
    expect(bash(`git commit -m "x\n\nCo-Authored-By: Jane Doe <jane@example.com>"`).decision).toBe("allow");
  });

  it("allows a commit with no trailer", () => {
    expect(bash(`git commit -m "fix: plain"`).decision).toBe("allow");
  });

  it("allows everything when attribution is not disabled", () => {
    expect(bash(`git commit -m "x\n\n${CLAUDE}"`, false).decision).toBe("allow");
  });

  it("ignores non-Bash tools and non-git commands", () => {
    expect(decideAttributionTrailer("Write", { file_path: "/x", content: CLAUDE }, true).decision).toBe("allow");
    expect(bash(`echo "${CLAUDE}"`).decision).toBe("allow");
  });
});

describe("readAttributionDisabled (#1007)", () => {
  const home = (settings?: string) => {
    const h = mkdtempSync(join(tmpdir(), "attrib-home-"));
    if (settings !== undefined) {
      mkdirSync(join(h, ".claude"));
      writeFileSync(join(h, ".claude", "settings.json"), settings);
    }
    return h;
  };

  it("true for attribution.commit === \"\"", () => {
    expect(readAttributionDisabled(home(`{"attribution":{"commit":"","pr":""}}`))).toBe(true);
  });
  it("true for legacy includeCoAuthoredBy: false", () => {
    expect(readAttributionDisabled(home(`{"includeCoAuthoredBy":false}`))).toBe(true);
  });
  it("false when attribution is customised or unset", () => {
    expect(readAttributionDisabled(home(`{"attribution":{"commit":"Co-Authored-By: x"}}`))).toBe(false);
    expect(readAttributionDisabled(home(`{}`))).toBe(false);
  });
  it("fails open on a missing or malformed file", () => {
    expect(readAttributionDisabled(home())).toBe(false);
    expect(readAttributionDisabled(home("{not json"))).toBe(false);
  });
});
