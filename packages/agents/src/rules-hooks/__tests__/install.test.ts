import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCodexRulesHooks, installGeminiRulesHooks, installOpencodeRulesHooks, installRulesHooks, OPENCODE_PLUGIN_MARKER } from "../install.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rules-hooks-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("codex hooks.json", () => {
  const target = path.join(root, "codex", "hooks.json");
  it("writes UserPromptSubmit + PostToolUse + SessionStart, keeps foreign entries, is idempotent", () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ other: 1, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    expect(installCodexRulesHooks({ target }).changed).toBe(true);
    const h = json(target);
    expect(h.other).toBe(1);
    expect(h.hooks.Stop[0].hooks[0].command).toBe("mine");
    expect(h.hooks.UserPromptSubmit[0].hooks[0].command).toBe("squadrant hooks codex prompt-submit");
    expect(h.hooks.PostToolUse[0].hooks[0].command).toBe("squadrant hooks codex post-tool-use");
    // #982: the profile has its own SessionStart command, so its own additionalContext string.
    expect(h.hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0].command))
      .toEqual(["squadrant hooks codex profile-session-start", "squadrant hooks codex session-start"]);
    expect(installCodexRulesHooks({ target }).changed).toBe(false);
    expect(json(target).hooks.SessionStart).toHaveLength(2);
    expect(json(target).hooks.UserPromptSubmit).toHaveLength(1);
  });
  it("dry run writes nothing; invalid JSON throws instead of clobbering", () => {
    const t = path.join(root, "codex2", "hooks.json");
    expect(installCodexRulesHooks({ target: t, dryRun: true }).changed).toBe(true);
    expect(fs.existsSync(t)).toBe(false);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, "{nope");
    expect(() => installCodexRulesHooks({ target: t })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(t, "utf8")).toBe("{nope");
  });
});

describe("gemini settings.json", () => {
  it("writes BeforeAgent + AfterTool(read_file) with ms timeouts, keeps other settings", () => {
    const target = path.join(root, "gemini", "settings.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ theme: "x" }));
    installGeminiRulesHooks({ target });
    const s = json(target);
    expect(s.theme).toBe("x");
    expect(s.hooks.BeforeAgent[0].hooks[0]).toEqual({ type: "command", command: "squadrant hooks gemini before-agent", timeout: 5000 });
    expect(s.hooks.AfterTool[0].matcher).toBe("read_file");
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: "squadrant hooks gemini profile-session-start", timeout: 5000 });
    expect(installGeminiRulesHooks({ target }).changed).toBe(false);
    expect(json(target).hooks.SessionStart).toHaveLength(2);
  });
});

describe("opencode plugin", () => {
  const target = path.join(root, "opencode", "plugin", "squadrant-rules.js");
  it("writes a managed plugin, is idempotent, never overwrites a foreign file", () => {
    expect(installOpencodeRulesHooks({ target }).changed).toBe(true);
    const src = fs.readFileSync(target, "utf8");
    expect(src.startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true);
    for (const k of ['"chat.message"', '"tool.execute.after"', "hooks", "opencode"]) expect(src).toContain(k);
    expect(installOpencodeRulesHooks({ target }).changed).toBe(false);
    const foreign = path.join(root, "opencode", "plugin", "mine.js");
    fs.writeFileSync(foreign, "// mine");
    expect(installOpencodeRulesHooks({ target: foreign })).toMatchObject({ changed: false, skipped: "foreign-file" });
    expect(fs.readFileSync(foreign, "utf8")).toBe("// mine");
  });
  it("plugin hooks: injects hook output into the prompt parts and the read output (stub CLI)", async () => {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, "squadrant-stub");
    fs.writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"additionalContext":"RULE-CTX"}}\'\n', { mode: 0o755 });
    const t = path.join(root, "oc2", "squadrant-rules.js");
    installOpencodeRulesHooks({ target: t, cli: stub });
    fs.writeFileSync(path.join(root, "oc2", "package.json"), '{"type":"module"}');
    const mod = await import(t);
    const hooks = await mod.SquadrantRules({ directory: root });
    const out = { parts: [{ type: "text", text: "hi" }], message: { id: "m1" } };
    await hooks["chat.message"]({ sessionID: "s" }, out);
    // #982: the first message of a session also gets the profile part, before the rules part.
    expect(out.parts).toHaveLength(3);
    expect(out.parts[1]).toMatchObject({ type: "text", text: "RULE-CTX", synthetic: true });
    expect(out.parts[2]).toMatchObject({ type: "text", text: "RULE-CTX", synthetic: true });
    await hooks["tool.execute.before"]({ tool: "read", callID: "c1" }, { args: { filePath: "a.sol" } });
    const res = { output: "file body" };
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "s", callID: "c1" }, res);
    expect(res.output).toBe("file body\n\nRULE-CTX");
    const other = { output: "x" };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s", callID: "c2" }, other);
    expect(other.output).toBe("x");
  });
  it("calls profile-session-start once per sessionID, on the first chat.message only (#982)", async () => {
    const bin = path.join(root, "bin2"); fs.mkdirSync(bin, { recursive: true });
    const log = path.join(bin, "calls.log");
    const stub = path.join(bin, "squadrant-stub");
    fs.writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\necho "$3" >> ${log}\nif [ "$3" = profile-session-start ]; then echo '{"hookSpecificOutput":{"additionalContext":"PROFILE-CTX"}}'; fi\n`, { mode: 0o755 });
    const t = path.join(root, "oc3", "squadrant-rules.js");
    installOpencodeRulesHooks({ target: t, cli: stub });
    fs.writeFileSync(path.join(root, "oc3", "package.json"), '{"type":"module"}');
    const hooks = await (await import(t)).SquadrantRules({ directory: root });
    const msg = () => ({ parts: [{ type: "text", text: "hi" }], message: { id: "m" } });
    const first = msg();
    await hooks["chat.message"]({ sessionID: "s1" }, first);
    expect(first.parts.map((p: { text: string }) => p.text)).toEqual(["hi", "PROFILE-CTX"]);
    const second = msg();
    await hooks["chat.message"]({ sessionID: "s1" }, second);
    expect(second.parts.map((p: { text: string }) => p.text)).toEqual(["hi"]);
    await hooks["chat.message"]({ sessionID: "s2" }, msg());
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter((c) => c === "profile-session-start")).toHaveLength(2);
    expect(calls.filter((c) => c === "chat-message")).toHaveLength(3);
  });
  it("installRulesHooks dispatches by agent", () => {
    expect(installRulesHooks("codex", { target: path.join(root, "d", "hooks.json") }).changed).toBe(true);
  });
});
