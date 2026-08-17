// packages/agents/src/opencode/http-channel.ts
//
// ControlChannel over opencode's embedded HTTP server (#667 slice 2).
//
// Interactive opencode crews already launch as `opencode --port <N>` and the port
// is persisted on the TaskRecord (rec.serverPort, crew-spawn.ts:400), so there is
// no discovery and no race — the daemon knows the address before it needs it.
//
// Verified live 2026-08-13 against opencode 1.18.18:
//   POST /session/{id}/prompt_async  → 204
//   POST /session/ses_bogus/…        → 404 {"name":"NotFoundError"}
//
// prompt_async is preferred over /tui/append-prompt + /tui/submit-prompt (both of
// which also work) because /tui/* targets whichever session the TUI has FOCUSED.
// Under operator takeover (#649) the operator may have switched sessions and the
// message would land in the wrong one with nothing to indicate it. prompt_async is
// addressed by session id and 404s on a wrong id — prefer the detectable failure.
import type { ControlChannel, DeliveryOutcome, ProbeResult } from "@squadrant/core";

export interface OpencodeHttpChannelDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** taskId → the crew's opencode server port, or undefined if unknown. */
  portFor: (taskId: string) => number | undefined;
  /** Per-request timeout (ms). Default 5000. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

interface OpencodeSession {
  id: string;
  time?: { updated?: number };
}

export class OpencodeHttpChannel implements ControlChannel {
  readonly name = "opencode-http" as const;
  readonly agent = "opencode";

  /** taskId → resolved session id. Invalidated on 404 (see send()). */
  private sessionByTask = new Map<string, string>();

  private readonly fetchImpl: typeof fetch;
  private readonly portFor: (taskId: string) => number | undefined;
  private readonly timeoutMs: number;
  private readonly log?: (msg: string) => void;

  constructor(deps: OpencodeHttpChannelDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.portFor = deps.portFor;
    this.timeoutMs = deps.timeoutMs ?? 5000;
    this.log = deps.log;
  }

  async send(taskId: string, message: string): Promise<DeliveryOutcome> {
    const port = this.portFor(taskId);
    if (port == null) return { status: "unsupported" };

    const sessionId = await this.resolveSession(taskId, port);
    if (!sessionId) return { status: "gone" };

    let res: Response;
    try {
      res = await this.request(
        `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: message }] }) },
      );
    } catch (e) {
      // Transport failure. Report gone so the caller falls back to the pane ONCE,
      // logged. Never loop here — the retry policy lives at the call site.
      this.log?.(`opencode-http send transport error for ${taskId}: ${(e as Error).message}`);
      return { status: "gone" };
    }

    if (res.status === 204 || res.status === 200) {
      return { status: "accepted", via: this.name };
    }
    if (res.status === 404) {
      // The session id is stale (crew restarted, session closed). Drop the cache
      // so the NEXT send re-resolves rather than 404ing forever against a dead id.
      this.sessionByTask.delete(taskId);
      this.log?.(`opencode-http: session ${sessionId} for ${taskId} is gone (404)`);
      return { status: "gone" };
    }
    this.log?.(`opencode-http: unexpected status ${res.status} for ${taskId}`);
    return { status: "gone" };
  }

  /**
   * Non-mutating reachability check. MUST NOT deliver anything — shadow mode
   * calls this alongside a real pane send, and a POST here would deliver the
   * message twice.
   */
  async probe(taskId: string): Promise<ProbeResult> {
    const port = this.portFor(taskId);
    if (port == null) return { status: "unsupported" };
    const sessionId = await this.resolveSession(taskId, port);
    return sessionId ? { status: "reachable", via: this.name } : { status: "gone" };
  }

  // ── private ───────────────────────────────────────────────────────────────

  /**
   * Resolve (and cache) the crew's session id.
   *
   * opencode 1.18.18 is mid-migration from /session/* to /api/session/*, so both
   * are tried. This is a capability probe, NOT a version comparison — the honest
   * check is "does this route answer", and neither path is a promised-stable
   * contract. Re-run the smoke suite when opencode is upgraded.
   */
  private async resolveSession(taskId: string, port: number): Promise<string | undefined> {
    const cached = this.sessionByTask.get(taskId);
    if (cached) return cached;

    for (const path of ["/session?", "/api/session?"]) {
      let res: Response;
      try {
        res = await this.request(`http://127.0.0.1:${port}${path}`, { method: "GET" });
      } catch {
        return undefined; // server unreachable — caller maps this to gone
      }
      if (!res.ok) continue;
      let sessions: OpencodeSession[];
      try {
        sessions = (await res.json()) as OpencodeSession[];
      } catch {
        continue;
      }
      if (!Array.isArray(sessions) || sessions.length === 0) continue;
      // A crew pane may hold several sessions; the most recently updated is the
      // one the operator is looking at.
      const newest = sessions.reduce((a, b) =>
        (b.time?.updated ?? 0) > (a.time?.updated ?? 0) ? b : a);
      if (!newest?.id) continue;
      this.sessionByTask.set(taskId, newest.id);
      return newest.id;
    }
    return undefined;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }
}