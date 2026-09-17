# U3 — Driver env-injection plumbing for router backend (#775) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A routed `claude` crew spawn carries the U1 env contract (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""` / `ANTHROPIC_MODEL`) in its **process environment at launch**; a `native` spawn is byte-for-byte unchanged.

**Architecture:** The daemon already owns the shim (its port, the per-project minted token) and exposes `RouterService.credentialsFor(project, backend)` — but only in-process (U2 plan: "No `router-credentials` wire protocol — U3 decides how the CLI reaches it"). U3 adds that wire verb, a pure env builder, and injects the result as a shell env prefix at the crew spawn site (before `nice`, because `nice -n 10 FOO=bar cmd` is invalid — the shell must process the assignments first). `settings.json env` is **not** used: per #775 precondition 1 it only reaches claude's child processes, not the interactive auth gate.

**Tech Stack:** TypeScript (ESM, `node:test`-free — vitest), pnpm workspaces, node `net` IPC, POSIX shell (`nice`, ANSI-C `$'…'` quoting).

**Specs:**
- U1 env contract: `docs/specs/2026-09-11-router-transport-u1-design.md` §Env contract
- U2 routing/daemon wiring: `docs/specs/2026-09-11-router-config-u2-design.md` §Routing semantics, §Daemon wiring
- Preconditions: `gh issue view 775 --comments` → "Preconditions for U3 env injection"

**Scope boundary (deliberate):** only the **crew** spawn path is wired. U2 spec decision 2 states `backend` on `captain`/`command`/`side`/`exploration` is "type-level only until a later unit wires those spawners"; U2 consumes only `roles.crew`. `packages/cli/src/commands/side.ts` is read-only context for U3. The reusable `buildRouterEnv` / `renderEnvAssignments` helpers make a later side-spawner follow-up a small wiring change.

---

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/core/src/router/env.ts` | **create** | Pure: router credentials → env map; env map → one-line shell prefix |
| `packages/core/src/router/credentials.ts` | **create** | Pure-ish: the `router-credentials` wire verb + bounded readiness wait |
| `packages/core/src/router/index.ts` | modify | Export the two new modules |
| `packages/core/src/daemon/server.ts` | modify | Dispatch the `router-credentials` request to `RouterService.credentialsFor` |
| `packages/core/src/crew-spawn.ts` | modify | Resolve + inject router env for a routed claude spawn; `native` untouched |
| `packages/agents/src/claude/api-key-approval.ts` | **create** | #775 precondition 3: reconcile `~/.claude.json` `customApiKeyResponses` |
| `packages/agents/src/index.ts` | modify | Export the pre-approval helper |
| `packages/cli/src/commands/crew.ts` | modify | CLI-edge: fetch credentials over the socket, pre-approve a `direct` key, pass dep |
| `docs/plans/2026-09-17-router-driver-env-u3-plan.md` | this file | Plan |

**Not modified (verified):** `packages/agents/src/drivers/claude.ts` and `SpawnOptions`. Injection is a command prefix at the spawn site (U1 research note: "`RuntimeSpawnOptions.command` is a shell string; UI/daemon layers can therefore inject env via the command prefix"). `--settings` is rejected by precondition 1. Keeping the driver dumb avoids the `nice`-ordering trap (see Architecture).

---

## Task 0: Branch + baseline

**Files:** none

- [ ] **Step 1: Confirm branch**

Run: `git status -sb && git log --oneline -1`
Expected: on `feat/775-driver-env-injection`, based on `develop` (`c7f1406`).

- [ ] **Step 2: Record the failing-test baseline**

Run: `pnpm test 2>&1 | tail -40`
Expected: capture the summary line. Known baseline: the relay-proxy tests are flaky (do **not** chase them). Save the failing test names so Task 7 is a diff, not a guess.

---

## Task 1: Pure env builder (`router/env.ts`)

**Files:**
- Create: `packages/core/src/router/env.ts`
- Test: `packages/core/src/router/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/router/__tests__/env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CMUX_PRESERVE_CLAUDE_AUTH_ENV,
  buildRouterEnv,
  formatCustomHeaders,
  renderEnvAssignments,
} from "../env.js";

describe("buildRouterEnv", () => {
  it("proxy: shim url + minted token + explicitly-empty API key + model", () => {
    const env = buildRouterEnv(
      { backend: "proxy", baseUrl: "http://127.0.0.1:53421", token: "minted-tok" },
      "deepseek-v4.1-flash",
    );
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:53421",
      ANTHROPIC_AUTH_TOKEN: "minted-tok",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
    });
    // Explicitly empty, never unset — an unset key falls back to Anthropic auth.
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
  });

  it("direct: upstream baseUrl + real credential + custom headers", () => {
    const env = buildRouterEnv(
      {
        backend: "direct",
        baseUrl: "https://opencode.ai/zen/go",
        apiKey: "sk-live",
        extraHeaders: { "x-opencode-session": "squadrant" },
      },
      "deepseek-v4.1-flash",
    );
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
      ANTHROPIC_API_KEY: "sk-live",
      ANTHROPIC_CUSTOM_HEADERS: "x-opencode-session: squadrant",
      ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
    });
  });

  it("omits ANTHROPIC_MODEL when no model resolved", () => {
    const env = buildRouterEnv({ backend: "proxy", baseUrl: "http://x", token: "t" }, undefined);
    expect("ANTHROPIC_MODEL" in env).toBe(false);
  });

  it("omits ANTHROPIC_CUSTOM_HEADERS when there are no extra headers", () => {
    const env = buildRouterEnv({ backend: "direct", baseUrl: "http://x", apiKey: "k" }, "m");
    expect("ANTHROPIC_CUSTOM_HEADERS" in env).toBe(false);
  });
});

describe("formatCustomHeaders", () => {
  it("joins pairs with newlines in the Name: Value format Claude Code expects", () => {
    expect(formatCustomHeaders({ "x-api-key": "a", "x-session": "b" })).toBe(
      "x-api-key: a\nx-session: b",
    );
  });

  it("returns undefined for empty/absent headers", () => {
    expect(formatCustomHeaders(undefined)).toBeUndefined();
    expect(formatCustomHeaders({})).toBeUndefined();
  });
});

describe("renderEnvAssignments", () => {
  it("renders a deterministic single-line prefix", () => {
    expect(renderEnvAssignments({ B: "2", A: "1" })).toBe("A=$'1' B=$'2'");
  });

  it("keeps a newline inside a value from becoming a command separator", () => {
    const line = renderEnvAssignments({ ANTHROPIC_CUSTOM_HEADERS: "a: 1\nb: 2" });
    expect(line).toBe("ANTHROPIC_CUSTOM_HEADERS=$'a: 1\\nb: 2'");
    expect(line).not.toContain("\n");
  });

  it("escapes quotes and backslashes", () => {
    expect(renderEnvAssignments({ K: "it's\\ok" })).toBe("K=$'it\\'s\\\\ok'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/env.test.ts`
Expected: FAIL — `Failed to resolve import "../env.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/router/env.ts`:

```ts
// packages/core/src/router/env.ts
// U3: build the process-env contract a routed `claude` spawn must carry.
// The names are U1's contract (docs/specs/2026-09-11-router-transport-u1-design.md
// §"Env contract"). Pure — no I/O — so the contract is unit-testable in isolation.

/** cmux's claude wrapper unsets ANTHROPIC_API_KEY / ANTHROPIC_MODEL /
 *  ANTHROPIC_SMALL_FAST_MODEL / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
 *  when IN_CMUX=1 unless this is set (#775 precondition 2). Without it the wrapper
 *  silently drops the auth selection and claude reports "Not logged in". */
export const CMUX_PRESERVE_CLAUDE_AUTH_ENV = "CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV";

/** Router credential shape this module consumes (structurally RouterCredentials). */
export interface RouterEnvCredentials {
  backend: "direct" | "proxy";
  baseUrl: string;
  /** proxy: the daemon-minted per-project bearer token. */
  token?: string;
  /** direct: the real upstream credential. */
  apiKey?: string;
  /** direct: static headers placed in ANTHROPIC_CUSTOM_HEADERS. */
  extraHeaders?: Record<string, string>;
}

/** Build the env assignments a routed claude spawn must carry.
 *  `proxy` points claude at the daemon's loopback shim; `direct` at the upstream.
 *  `native` never reaches here — it injects nothing (byte-for-byte unchanged). */
export function buildRouterEnv(
  creds: RouterEnvCredentials,
  model: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: creds.baseUrl,
    // Empty string, never unset: an unset key lets Claude Code fall back to
    // authenticating against Anthropic directly (U1 §Env contract).
    ANTHROPIC_API_KEY: creds.backend === "direct" ? (creds.apiKey ?? "") : "",
    [CMUX_PRESERVE_CLAUDE_AUTH_ENV]: "1",
  };
  if (creds.backend === "proxy") {
    env.ANTHROPIC_AUTH_TOKEN = creds.token ?? "";
  } else {
    const headers = formatCustomHeaders(creds.extraHeaders);
    if (headers) env.ANTHROPIC_CUSTOM_HEADERS = headers;
  }
  if (model) env.ANTHROPIC_MODEL = model;
  return env;
}

/** `ANTHROPIC_CUSTOM_HEADERS` is one `Name: Value` pair per line. */
export function formatCustomHeaders(
  headers: Record<string, string> | undefined,
): string | undefined {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** Render env assignments as a single-line shell prefix.
 *  Values are ANSI-C quoted (`$'…'`) so spaces, quotes, and the newline inside
 *  ANTHROPIC_CUSTOM_HEADERS survive — the spawn line is typed into a terminal, so
 *  a literal newline would be read as Enter and submit a truncated command. */
export function renderEnvAssignments(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${ansiCQuote(env[key] ?? "")}`)
    .join(" ");
}

function ansiCQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
  return `$'${escaped}'`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/router/__tests__/env.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/env.ts packages/core/src/router/__tests__/env.test.ts
git commit -m "feat(#775): pure router env builder for routed claude spawns"
```

---

## Task 2: `router-credentials` wire verb + readiness wait (`router/credentials.ts`)

**Files:**
- Create: `packages/core/src/router/credentials.ts`
- Modify: `packages/core/src/router/index.ts`
- Test: `packages/core/src/router/__tests__/credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/router/__tests__/credentials.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  ROUTER_READY_ATTEMPTS,
  buildRouterCredentialsRequest,
  resolveRouterCredentials,
} from "../credentials.js";
import type { RouterService } from "../service.js";

function makeService(overrides: Partial<RouterService> = {}): RouterService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    url: vi.fn().mockReturnValue("http://127.0.0.1:1"),
    health: vi.fn().mockResolvedValue({ ready: true, upstreamReachable: true }),
    credentialsFor: vi.fn().mockReturnValue({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "t" }),
    ...overrides,
  } as unknown as RouterService;
}

describe("buildRouterCredentialsRequest", () => {
  it("builds the wire request", () => {
    expect(buildRouterCredentialsRequest("proj", "proxy")).toEqual({
      kind: "router-credentials",
      project: "proj",
      backend: "proxy",
    });
  });
});

describe("resolveRouterCredentials", () => {
  it("waits for the shim to become ready, then returns credentials", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, upstreamReachable: true })
      .mockResolvedValue({ ready: true, upstreamReachable: true });
    const svc = makeService({ health: health as unknown as RouterService["health"] });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const creds = await resolveRouterCredentials(svc, "proj", "proxy", { sleep });

    expect(health).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(svc.credentialsFor).toHaveBeenCalledWith("proj", "proxy");
    expect(creds).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "t" });
  });

  it("does not wait for a direct backend (no shim in the path)", async () => {
    const svc = makeService();
    await resolveRouterCredentials(svc, "proj", "direct", { sleep: vi.fn() });
    expect(svc.health).not.toHaveBeenCalled();
    expect(svc.credentialsFor).toHaveBeenCalledWith("proj", "direct");
  });

  it("gives up after the bounded attempts and lets credentialsFor surface the error", async () => {
    const svc = makeService({
      health: vi.fn().mockResolvedValue({ ready: false, upstreamReachable: true }),
      credentialsFor: vi.fn().mockImplementation(() => {
        throw new Error("router service not started");
      }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(resolveRouterCredentials(svc, "proj", "proxy", { sleep })).rejects.toThrow(
      /not started/,
    );
    expect(sleep).toHaveBeenCalledTimes(ROUTER_READY_ATTEMPTS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/router/__tests__/credentials.test.ts`
Expected: FAIL — `Failed to resolve import "../credentials.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/router/credentials.ts`:

```ts
// packages/core/src/router/credentials.ts
// U3: the CLI↔daemon verb a routed spawn uses to obtain the shim URL + minted
// token. The shim is daemon-internal (U2 decision 1), so the spawn path cannot
// derive these locally. Additive protocol kind — both sides ship together, so
// PROTOCOL_VERSION is not bumped (an older running daemon simply errors, which
// the spawn surfaces as a hard failure rather than a silent unauth'd launch).
import type { RouterCredentials, RouterService } from "./service.js";

export type RouterBackend = "direct" | "proxy";

export interface RouterCredentialsRequest {
  kind: "router-credentials";
  project: string;
  backend: RouterBackend;
}

export function buildRouterCredentialsRequest(
  project: string,
  backend: RouterBackend,
): RouterCredentialsRequest {
  return { kind: "router-credentials", project, backend };
}

/** Bounded readiness wait: 10 × 200 ms = 2 s (well inside the CLI's 5 s socket
 *  timeout). `service.start()` is fire-and-forget at daemon boot, so
 *  `credentialsFor("proxy")` throws "router service not started" until it
 *  resolves (U2 plan Task 4.2 note: "U3 owns waiting on health()"). */
export const ROUTER_READY_ATTEMPTS = 10;
export const ROUTER_READY_DELAY_MS = 200;

export async function resolveRouterCredentials(
  service: RouterService,
  project: string,
  backend: RouterBackend,
  deps: { sleep?: (ms: number) => Promise<void>; attempts?: number; delayMs?: number } = {},
): Promise<RouterCredentials> {
  if (backend === "proxy") {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempts = deps.attempts ?? ROUTER_READY_ATTEMPTS;
    const delayMs = deps.delayMs ?? ROUTER_READY_DELAY_MS;
    for (let i = 0; i < attempts; i++) {
      const health = await service.health();
      if (health.ready) break;
      await sleep(delayMs);
    }
  }
  return service.credentialsFor(project, backend);
}
```

- [ ] **Step 4: Export from the router barrel**

Modify `packages/core/src/router/index.ts` — append:

```ts
export * from "./env.js";
export * from "./credentials.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/src/router/__tests__/credentials.test.ts packages/core/src/router/__tests__/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/router/credentials.ts packages/core/src/router/index.ts packages/core/src/router/__tests__/credentials.test.ts
git commit -m "feat(#775): router-credentials wire verb + bounded shim readiness wait"
```

---

## Task 3: Daemon dispatch for `router-credentials`

**Files:**
- Modify: `packages/core/src/daemon/server.ts`
- Test: `packages/core/src/daemon/__tests__/router-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/daemon/__tests__/router-credentials.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "../../protocol.js";
import { createServer } from "../server.js";
import type { DaemonContext } from "../context.js";
import type { RouterService } from "../../router/service.js";

function makeCtx(routerService: RouterService | undefined, sockPath: string): DaemonContext {
  return {
    sockPath,
    store: { put: vi.fn(), get: vi.fn() },
    log: vi.fn(),
    attachConns: new Map(),
    d: { handle: vi.fn() },
    routerService,
  } as unknown as DaemonContext;
}

const noopHandlers = {
  buildHealth: () => [],
  gatherSnapshotInputs: vi.fn(),
  cancelPromotionsFor: vi.fn(),
  broadcast: vi.fn(),
};

describe("daemon router-credentials dispatch", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it("returns credentials from the router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-rc-"));
    const sock = join(dir, "s.sock");
    const routerService = {
      health: vi.fn().mockResolvedValue({ ready: true, upstreamReachable: true }),
      credentialsFor: vi.fn().mockReturnValue({
        backend: "proxy",
        baseUrl: "http://127.0.0.1:5555",
        token: "tok",
      }),
    } as unknown as RouterService;
    const server = createServer(makeCtx(routerService, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    const res = await sendRequest(sock, { kind: "router-credentials", project: "p", backend: "proxy" });

    expect(res).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:5555", token: "tok" });
    expect(routerService.credentialsFor).toHaveBeenCalledWith("p", "proxy");
  });

  it("fails loud when the daemon has no router service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-rc-"));
    const sock = join(dir, "s.sock");
    const server = createServer(makeCtx(undefined, sock), noopHandlers);
    cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };

    await expect(
      sendRequest(sock, { kind: "router-credentials", project: "p", backend: "direct" }),
    ).rejects.toThrow(/no router service/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/daemon/__tests__/router-credentials.test.ts`
Expected: FAIL — the request falls through to `ctx.d.handle` (which in the fake is a `vi.fn()` returning `undefined`), so the reply is `undefined` and the first assertion fails; the second fails because no error is thrown.

- [ ] **Step 3: Write the implementation**

Modify `packages/core/src/daemon/server.ts` — add the import near the other relative imports:

```ts
import { resolveRouterCredentials } from "../router/credentials.js";
```

and insert this branch in the handler, immediately after the `snapshot` branch and **before** the `event` branch:

```ts
      // U3: a routed claude spawn cannot derive the shim port/token locally
      // (they are daemon-internal), so it asks the daemon that owns the shim.
      if (msg.kind === "router-credentials") {
        const service = ctx.routerService;
        if (!service) {
          throw new Error(
            "router backend selected but squadrantd has no router service — configure defaults.router and restart the daemon",
          );
        }
        return resolveRouterCredentials(
          service,
          msg.project as string,
          msg.backend as "direct" | "proxy",
        );
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/daemon/__tests__/router-credentials.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/server.ts packages/core/src/daemon/__tests__/router-credentials.test.ts
git commit -m "feat(#775): daemon serves router-credentials to the routed spawn path"
```

---

## Task 4: Inject env into the routed claude crew spawn (`crew-spawn.ts`)

**Files:**
- Modify: `packages/core/src/crew-spawn.ts`
- Test: `packages/core/src/__tests__/crew-spawn.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("routing", …)` block in `packages/core/src/__tests__/crew-spawn.test.ts` (after the "ignores the role backend…" test, before the block's closing `});`):

```ts
    it("injects the router env prefix for a routed claude spawn (#775)", async () => {
      const config = makeConfig({
        router: { kind: "opencode-go", baseUrl: "https://opencode.ai/zen/go", apiKey: "k" },
        crewRouting: {
          rules: [{ match: "refactor", agent: "claude", tier: "hard", backend: "proxy", model: "flash" }],
        },
      });
      const runtime = makeRuntime();
      const deps = makeSpawnDeps(runtime, makeAgent("claude"));
      const routerCredentials = vi.fn().mockResolvedValue({
        backend: "proxy",
        baseUrl: "http://127.0.0.1:53421",
        token: "minted-tok",
      });
      deps.routerCredentials = routerCredentials;

      await runCrewSpawn({ project: PROJECT, task: "refactor the daemon" }, config, deps);

      expect(routerCredentials).toHaveBeenCalledWith({ project: PROJECT, backend: "proxy" });
      const line = vi.mocked(runtime.sendToPane).mock.calls[0]![1] as string;
      expect(line).toContain("ANTHROPIC_BASE_URL=$'http://127.0.0.1:53421'");
      expect(line).toContain("ANTHROPIC_AUTH_TOKEN=$'minted-tok'");
      expect(line).toContain("ANTHROPIC_API_KEY=$''");
      expect(line).toContain("ANTHROPIC_MODEL=$'deepseek-v4.1-flash'");
      expect(line).toContain("CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV=$'1'");
      // The assignments must precede `nice` — `nice -n 10 FOO=bar cmd` is invalid.
      expect(line.indexOf("ANTHROPIC_BASE_URL")).toBeLessThan(line.indexOf("nice -n"));
    });

    it("injects nothing for a native claude spawn (byte-for-byte)", async () => {
      const config = makeConfig();
      const runtime = makeRuntime();
      const deps = makeSpawnDeps(runtime, makeAgent("claude"));
      deps.routerCredentials = vi.fn();

      await runCrewSpawn({ project: PROJECT, task: "fix the bug" }, config, deps);

      const line = vi.mocked(runtime.sendToPane).mock.calls[0]![1] as string;
      expect(line).not.toContain("ANTHROPIC_");
      expect(line).not.toContain("CMUX_PRESERVE");
      expect(deps.routerCredentials).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts -t "router env prefix"`
Expected: FAIL — `deps.routerCredentials` is not part of `CrewSpawnDeps` (TS error) and the launch line carries no `ANTHROPIC_`.

- [ ] **Step 3: Write the implementation**

Modify `packages/core/src/crew-spawn.ts`.

3a. Add imports (next to the `./router-resolution.js` import):

```ts
import { buildRouterEnv, renderEnvAssignments } from "./router/env.js";
import type { RouterCredentials } from "./router/service.js";
```

3b. Add the optional dep to `CrewSpawnDeps` (after `onBackendResolved?`):

```ts
  /** U3: CLI-edge — resolve router credentials for a routed claude spawn over
   *  the daemon socket (the shim's port and minted token are daemon-internal).
   *  Absent ⇒ a routed spawn fails loud instead of launching unauthenticated. */
  routerCredentials?(o: { project: string; backend: "direct" | "proxy" }): Promise<RouterCredentials>;
```

3c. At the top of the claude branch (immediately after `if (agentName === "claude") {`, before `ensureSocksDir()`), resolve the env:

```ts
    // U3: a routed spawn must carry the router env in its PROCESS environment at
    // launch — a settings.json `env` block only reaches claude's child processes
    // and does not satisfy the interactive auth gate (#775 precondition 1).
    // `native` injects nothing.
    let routerEnv: Record<string, string> = {};
    if (backend !== "native") {
      if (!deps.routerCredentials) {
        throw new Error(
          `backend '${backend}' requires router credentials, but the spawn path has no daemon credentials provider`,
        );
      }
      routerEnv = buildRouterEnv(
        await deps.routerCredentials({ project: input.project, backend }),
        crewModel,
      );
    }
```

3d. Replace the launch line (currently `await deps.runtime.sendToPane(pane, \`cd ${shellQuote(spawnCwd)} && ${envPrefix} ${niceCrewCommand(cliCommand)}\`);`) with:

```ts
    // Render the router env OUTSIDE `nice`: the shell must process the
    // assignments before exec, and `nice -n 10 FOO=bar cmd` is invalid (nice
    // would try to exec the literal `FOO=bar`). Empty for `native`, so a native
    // spawn's command line is byte-for-byte unchanged.
    const routerPrefix =
      Object.keys(routerEnv).length > 0 ? ` ${renderEnvAssignments(routerEnv)}` : "";
    await deps.runtime.sendToPane(
      pane,
      `cd ${shellQuote(spawnCwd)} && ${envPrefix}${routerPrefix} ${niceCrewCommand(cliCommand)}`,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/__tests__/crew-spawn.test.ts`
Expected: PASS — the two new tests and all pre-existing crew-spawn tests (the native launch line assertion at line ~243 still matches).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/crew-spawn.ts packages/core/src/__tests__/crew-spawn.test.ts
git commit -m "feat(#775): inject router env into the routed claude crew spawn"
```

---

## Task 5: `~/.claude.json` API-key pre-approval (precondition 3)

**Files:**
- Create: `packages/agents/src/claude/api-key-approval.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/claude/__tests__/api-key-approval.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/claude/__tests__/api-key-approval.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeApiKeyApproved } from "../api-key-approval.js";

const KEY = "sk-ant-abcdefghijklmnopqrstuvwx0123456789c1r63X2ikeuYCu1ewPVI";
const SUFFIX = KEY.slice(-20);

describe("ensureClaudeApiKeyApproved", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cp-claude-auth-"));
    file = join(dir, ".claude.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(doc: unknown): void {
    writeFileSync(file, JSON.stringify(doc));
  }
  function read(): any {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  it("moves a rejected key into approved (#775 precondition 3)", () => {
    write({ customApiKeyResponses: { approved: [], rejected: [SUFFIX] }, other: 1 });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    const doc = read();
    expect(doc.customApiKeyResponses.rejected).toEqual([]);
    expect(doc.customApiKeyResponses.approved).toEqual([SUFFIX]);
    expect(doc.other).toBe(1); // unrelated fields preserved
  });

  it("adds an unlisted key to approved (avoids the interactive prompt)", () => {
    write({ customApiKeyResponses: { approved: ["other"], rejected: [] } });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    expect(read().customApiKeyResponses.approved).toEqual(["other", SUFFIX]);
  });

  it("is a no-op when the key is already approved", () => {
    write({ customApiKeyResponses: { approved: [SUFFIX], rejected: [] } });
    const before = readFileSync(file, "utf8");
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("creates the responses block when absent", () => {
    write({ numStartups: 3 });
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(true);
    expect(read().customApiKeyResponses.approved).toEqual([SUFFIX]);
    expect(read().numStartups).toBe(3);
  });

  it("reports without throwing when the file is missing", () => {
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: join(dir, "nope.json") });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/no .*\.claude\.json/);
  });

  it("reports without throwing when the file is not valid JSON", () => {
    writeFileSync(file, "{ not json");
    const r = ensureClaudeApiKeyApproved(KEY, { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
  });

  it("ignores an empty key", () => {
    write({ customApiKeyResponses: { approved: [], rejected: [] } });
    const r = ensureClaudeApiKeyApproved("", { claudeJsonPath: file });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/empty api key/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/api-key-approval.test.ts`
Expected: FAIL — `Failed to resolve import "../api-key-approval.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/agents/src/claude/api-key-approval.ts`:

```ts
// packages/agents/src/claude/api-key-approval.ts
// #775 precondition 3: Claude Code records API-key approve/reject decisions in
// `~/.claude.json` under `customApiKeyResponses`. A key whose last 20 chars sit
// in `rejected` is REFUSED client-side — the session reports "Not logged in"
// with the env perfectly correct. A key in neither list triggers an interactive
// prompt, which an unattended crew cannot answer. Reconcile the routed key into
// `approved` before launching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EnsureApprovedResult {
  changed: boolean;
  /** Present when nothing was written, for an actionable log line. */
  reason?: string;
}

/**
 * Best-effort and idempotent. Never throws — a failure to reconcile must
 * surface as a clear log line, not a silent "Not logged in" (or a crashed spawn).
 */
export function ensureClaudeApiKeyApproved(
  apiKey: string,
  opts: { claudeJsonPath?: string; log?: (m: string) => void } = {},
): EnsureApprovedResult {
  const suffix = apiKey.slice(-20);
  if (!suffix) return { changed: false, reason: "empty api key" };

  const file = opts.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
  const log = opts.log ?? (() => {});
  if (!fs.existsSync(file)) {
    return { changed: false, reason: "no ~/.claude.json yet — skipping routed-key pre-approval" };
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { changed: false, reason: "~/.claude.json is not valid JSON — skipped routed-key pre-approval" };
  }

  const responses = (doc.customApiKeyResponses ?? {}) as {
    approved?: string[];
    rejected?: string[];
  };
  const approved = Array.isArray(responses.approved) ? [...responses.approved] : [];
  const rejected = Array.isArray(responses.rejected) ? [...responses.rejected] : [];
  const wasRejected = rejected.includes(suffix);
  if (!wasRejected && approved.includes(suffix)) return { changed: false };

  if (!approved.includes(suffix)) approved.push(suffix);
  doc.customApiKeyResponses = {
    ...responses,
    approved,
    rejected: rejected.filter((s) => s !== suffix),
  };

  try {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  } catch (e) {
    return {
      changed: false,
      reason: `could not write ~/.claude.json: ${(e as Error).message} — routed key may be refused as "Not logged in"`,
    };
  }

  log(
    wasRejected
      ? "claude: pre-approved the routed API key (it was in customApiKeyResponses.rejected — would have reported 'Not logged in')"
      : "claude: pre-approved the routed API key",
  );
  return { changed: true };
}
```

- [ ] **Step 4: Export it**

Modify `packages/agents/src/index.ts` — add after the `ClaudeReceiptListener` export line:

```ts
export { ensureClaudeApiKeyApproved } from "./claude/api-key-approval.js";
export type { EnsureApprovedResult } from "./claude/api-key-approval.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/agents/src/claude/__tests__/api-key-approval.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/claude/api-key-approval.ts packages/agents/src/index.ts packages/agents/src/claude/__tests__/api-key-approval.test.ts
git commit -m "feat(#775): pre-approve the routed claude API key in ~/.claude.json"
```

---

## Task 6: CLI wiring — socket fetch + pre-approval

**Files:**
- Modify: `packages/cli/src/commands/crew.ts`
- Test: `packages/cli/src/__tests__/crew-router-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/crew-router-credentials.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchRouterCredentials } from "../commands/crew.js";

describe("fetchRouterCredentials", () => {
  it("requests credentials over the daemon socket", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "proxy",
      baseUrl: "http://127.0.0.1:1",
      token: "tok",
    });
    const creds = await fetchRouterCredentials("proj", "proxy", { call });
    expect(call).toHaveBeenCalledWith({
      kind: "router-credentials",
      project: "proj",
      backend: "proxy",
    });
    expect(creds).toEqual({ backend: "proxy", baseUrl: "http://127.0.0.1:1", token: "tok" });
  });

  it("pre-approves the key for a direct backend", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "direct",
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "sk-live",
    });
    const approveKey = vi.fn().mockReturnValue({ changed: true });
    const log = vi.fn();
    await fetchRouterCredentials("proj", "direct", { call, approveKey, log });
    expect(approveKey).toHaveBeenCalledWith("sk-live", expect.objectContaining({ log }));
  });

  it("logs why pre-approval was skipped instead of failing silently", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "direct",
      baseUrl: "https://x",
      apiKey: "sk-live",
    });
    const approveKey = vi.fn().mockReturnValue({ changed: false, reason: "no ~/.claude.json yet" });
    const log = vi.fn();
    await fetchRouterCredentials("proj", "direct", { call, approveKey, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no ~/.claude.json yet"));
  });

  it("does not pre-approve for a proxy backend (no real key in the env)", async () => {
    const call = vi.fn().mockResolvedValue({
      backend: "proxy",
      baseUrl: "http://127.0.0.1:1",
      token: "tok",
    });
    const approveKey = vi.fn();
    await fetchRouterCredentials("proj", "proxy", { call, approveKey });
    expect(approveKey).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/crew-router-credentials.test.ts`
Expected: FAIL — `fetchRouterCredentials` is not exported.

- [ ] **Step 3: Write the implementation**

Modify `packages/cli/src/commands/crew.ts`.

3a. Extend imports:

```ts
import { CapabilityRegistry, createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, OpencodeHttpChannel, ClaudePeerChannel, ClaudeReceiptListener, readClaudeStatus, writeLine, ensureClaudeApiKeyApproved, type EnsureApprovedResult } from "@squadrant/agents";
```

and add `buildRouterCredentialsRequest` to the `@squadrant/core` import block, plus a `RouterCredentials` type import:

```ts
import {
  runCrewSpawn as coreRunCrewSpawn,
  // …existing…
  buildRouterCredentialsRequest,
  type RouterCredentials,
} from "@squadrant/core";
```

3b. Add the exported, testable CLI-edge helper (place it just above `runCrewSpawn`):

```ts
/** U3 CLI edge: fetch router credentials from the daemon that owns the shim,
 *  and — for `direct` (where the real upstream key rides in ANTHROPIC_API_KEY) —
 *  reconcile it into `~/.claude.json`'s approved list first (#775 precondition 3).
 *  A `proxy` spawn carries only the daemon-minted token, so there is no key to
 *  pre-approve. */
export async function fetchRouterCredentials(
  project: string,
  backend: "direct" | "proxy",
  deps: {
    call: (req: unknown) => Promise<unknown>;
    approveKey?: (key: string, opts: { log: (m: string) => void }) => EnsureApprovedResult;
    log?: (m: string) => void;
  },
): Promise<RouterCredentials> {
  const log = deps.log ?? ((m: string) => console.log(chalk.dim(m)));
  const creds = (await deps.call(buildRouterCredentialsRequest(project, backend))) as RouterCredentials;
  if (creds.backend === "direct" && creds.apiKey) {
    const approve = deps.approveKey ?? ensureClaudeApiKeyApproved;
    const result = approve(creds.apiKey, { log });
    if (!result.changed && result.reason) {
      log(`claude: routed key pre-approval skipped — ${result.reason}`);
    }
  }
  return creds;
}
```

3c. Wire the dep into `runCrewSpawn`'s `coreRunCrewSpawn(...)` deps object (after `resolveAgent`):

```ts
    routerCredentials: (o) => fetchRouterCredentials(o.project, o.backend, { call: squadrantdCall }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/crew-router-credentials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm lint`
Expected: PASS (no output).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/crew.ts packages/cli/src/__tests__/crew-router-credentials.test.ts
git commit -m "feat(#775): CLI fetches router credentials + pre-approves a direct key"
```

---

## Task 7: Full verification

**Files:** none (record results in the PR body)

- [ ] **Step 1: Lint/typecheck**

Run: `pnpm lint`
Expected: exit 0.

- [ ] **Step 2: Full test suite**

Run: `pnpm test 2>&1 | tail -40`
Expected: PASS except the pre-existing flaky relay-proxy tests recorded in Task 0 — compare, do not chase.

- [ ] **Step 3: Native-unchanged proof**

Run:

```bash
pnpm test 2>&1 | grep -E "crew-spawn|router|api-key" | head -20
git diff --stat develop..HEAD
```

Expected: the native crew-spawn tests unchanged and green; the diff contains only the files in the File-structure table.

- [ ] **Step 4: Commit any plan/verification notes** (if the plan was updated)

```bash
git add docs/plans/2026-09-17-router-driver-env-u3-plan.md
git commit -m "docs(#775): record U3 verification"
```

---

## Task 8: Remove the temp brief, push, open PR

**Files:**
- Delete: `u3-brief.md` (temp file copied in by crew spawn — must never be committed)

- [ ] **Step 1: Remove the temp brief and confirm it is untracked**

Run: `rm -f u3-brief.md && git status --porcelain`
Expected: no `u3-brief.md` entry.

- [ ] **Step 2: Push**

Run: `git push -u origin feat/775-driver-env-injection`
Expected: branch pushed.

- [ ] **Step 3: Open the PR (base `develop`, do NOT merge)**

Run:

```bash
gh pr create --base develop --head feat/775-driver-env-injection \
  --title "feat(#775): driver env-injection plumbing for router backend (U3)" \
  --body "…"
```

PR body must include: the env contract injected; the three #775 preconditions and how each is handled; the deliberate scope boundary (side spawner not wired — U2 decision 2); the flaky-test baseline note; and the test files added.

- [ ] **Step 4: Report**

Report the PR number + a summary via the completion protocol.

---

## Self-review

**Spec coverage:**
- U1 §Env contract (proxy 4 vars, `ANTHROPIC_API_KEY=""` not unset) → Task 1 (`buildRouterEnv`) + Task 4 (injection) ✅
- U2 §Routing semantics table `direct` row (`baseUrl` + real credential + `ANTHROPIC_CUSTOM_HEADERS`) → Task 1 ✅
- U2 §Daemon wiring sketch (`router-credentials` request/response shape) → Task 2 + Task 3 ✅
- U2 readiness note ("U3 owns waiting on `health()`") → Task 2 (`resolveRouterCredentials`) ✅
- #775 precondition 1 (process env at launch) → Task 4 (shell prefix, before `nice`) ✅
- #775 precondition 2 (cmux strip) → Task 1 (`CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV=1`) ✅
- #775 precondition 3 (`customApiKeyResponses.rejected`) → Task 5 + Task 6 ✅
- Acceptance "native spawn injects none / byte-for-byte" → Task 4 test ✅
- Acceptance "unit test on command construction for both backends" → Task 4 tests ✅

**Type consistency:** `RouterEnvCredentials` (Task 1) is structurally a subset of `RouterCredentials` (U2 `service.ts`); `buildRouterEnv` accepts it directly. `resolveRouterCredentials` (Task 2) returns `RouterCredentials`; `CrewSpawnDeps.routerCredentials` (Task 4) returns `RouterCredentials`; `fetchRouterCredentials` (Task 6) returns `RouterCredentials`. `renderEnvAssignments` defined Task 1, used Task 4. `ensureClaudeApiKeyApproved` defined Task 5, consumed Task 6 as `approveKey`.

**Out of scope (explicit):** side/captain/command/exploration spawner wiring; U7 permission gate; shim/config redesign; `PROTOCOL_VERSION` bump.

---

## Verification log

Recorded 2026-09-17 on `feat/775-driver-env-injection`.

**Baseline (develop, `c7f1406`)** — `pnpm build` then `pnpm test`:
`Test Files 237 passed (237)` · `Tests 3139 passed (3139)` · 0 failures.
(The suite requires a prior `pnpm build` in the worktree; without it,
cross-package imports fail to resolve and ~115 files error at collection.)

**After U3:**

```
$ pnpm build          # tsc -b (all six packages) + tsup
ESM Build success

$ pnpm test
Test Files  242 passed (242)
     Tests  3169 passed (3169)
```

- `pnpm lint` (root `tsc --noEmit`) reports only pre-existing `node_modules`
  (`vite`/`vitest` d.ts) and `tsup.config.ts` errors — `grep -c '^packages/'` → `0`.
  The authoritative per-package typecheck is `pnpm build`, which passes.
- New test files (5): `router/__tests__/env.test.ts`,
  `router/__tests__/credentials.test.ts`,
  `daemon/__tests__/router-credentials.test.ts`,
  `claude/__tests__/api-key-approval.test.ts`,
  `cli/src/__tests__/crew-router-credentials.test.ts`.
- Native-unchanged: the launch line for `backend: "native"` is
  `${envPrefix}${routerPrefix} ${niceCrewCommand(cmd)}` with `routerPrefix === ""`,
  byte-identical to `develop`'s `${envPrefix} ${niceCrewCommand(cmd)}`;
  `deps.routerCredentials` is never called (asserted in
  `crew-spawn.test.ts` → "injects nothing for a native claude spawn").
- `docs/generated/control-events.md` regenerated — my `crew-spawn.ts` edit shifted
  the embedded source line numbers (same as U2's `a38e718`).

**Independent review finding, fixed before PR.** A review subagent found that
`ANTHROPIC_CUSTOM_HEADERS` embeds a newline, and `sanitizeForCmuxSend()`
(`packages/workspaces/src/runtimes/cmux.ts:144`) rewrites a literal `\n` escape to a
space — so `$'…\n…'` reached the shell as a single header and every entry after the
first was silently dropped in `direct` mode. Fixed by emitting `\x0a` (unmatched by
`\\[nrt]`, decodes to a newline in both zsh and bash, 2-hex-digit unambiguous), with
a regression case in the cmux sanitizer suite. Two smaller review items also fixed:
the `~/.claude.json` rewrite is now atomic (temp + `renameSync`, original mode
preserved, temp cleaned on failure), and a skipped key pre-approval now emits a
visible warning rather than a dim log line (#775 precondition 3 requires a
non-silent surface).

