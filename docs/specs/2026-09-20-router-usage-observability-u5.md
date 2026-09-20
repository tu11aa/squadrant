# Router usage observability — U5 design

**Status:** implemented (v1)
**Date:** 2026-09-20
**Issue:** [#777](https://github.com/tu11aa/squadrant/issues/777) (epic [#772](https://github.com/tu11aa/squadrant/issues/772))
**Depends on:** U1 (router shim cost tee, `docs/specs/2026-09-11-router-transport-u1-design.md`), U2 (router config), U3 (env injection).

## Goal

Make routed work observable: which **model** ran, and what it **cost**. U1's shim already
tees `usage` / `cost` off the upstream response, but the captured `RouterUsage` was pushed to an
`onUsage` callback that the daemon never wired, and the model was never recorded. U5 closes that
gap end-to-end.

## Accumulation granularity: **per project, grouped by model**

The router shim authenticates requests with a **per-project** bearer token (U1). The shim
therefore cannot attribute a request to a specific crew — it only knows the project. Given the
choice of per-crew / per-project / per-day:

- **Per-crew is not reachable without changing the auth model.** It would require minting a token
  per `(project, taskId)` and threading the task id from dispatch through the credentials request
  into the shim. The task id is generated *after* the router credentials are fetched in the spawn
  path (`packages/core/src/crew-spawn.ts`), so this is a real (if bounded) reordering + auth-map
  change, not a surgical one. **Deferred** — see "Follow-up" below.
- **Per-day** adds a reset boundary and clock state to the daemon for no requested benefit.
- **Per-project** is what the existing token model gives for free, and is enough to answer the
  headline questions ("which models are we paying for, and how much").
- We still record the **model per request**, captured from the request body, and group accumulated
  cost by model, so the per-project total carries a model breakdown.

This granularity is documented here and surfaced in the command output itself (`router: … total`).

## What is captured

- **Model** — read from the request body (`body.model`, the `ANTHROPIC_MODEL` U3 injects) in
  `router/shim.ts`, attached to every `RouterUsage` (`router/types.ts`).
- **Usage / cost** — parsed by U1's tee (`router/stream.ts`) exactly as before; U5 only consumes it.

## Where it is displayed

| Surface | Mechanism |
|---|---|
| `squadrant crew tasks <project>` | compact output appends a `router:` footer: project total + per-model breakdown (sorted by cost desc). Only queried when `defaults.router` is configured. |
| Telegram crew events | terminal (`task.done` / `task.failed`) lifecycle messages append a one-line `💰 …·…` cost summary via the bridge's `usageFor` hook. |
| Status board / dashboard | `ProjectDataPlane.routerUsage` in the daemon `snapshot` verb (`assembleDaemonSnapshot`), i.e. the same data source the web dashboard consumes. |

Wiring: `createRouterService` owns an in-memory `RouterUsageLedger`
(`packages/core/src/router/usage-ledger.ts`) and passes `onUsage` to the shim. The daemon exposes
it read-only over the socket (`router-usage` verb) and via the snapshot.

## Non-goals (v1)

- No local price table / model-pricing database (cost is whatever the upstream reports).
- No credential pools or quota tracking.
- No per-crew attribution (see below) — no persistence across daemon restarts; the ledger is
  in-memory and resets on daemon bounce.

## Follow-up

Per-crew attribution (`#777` follow-up): mint a per-`(project, taskId)` token and thread the task
id through `RouterCredentialsRequest` → `RouterService.credentialsFor` → the shim's usage tee,
after moving task dispatch ahead of the credentials fetch in `crew-spawn.ts`. That turns the
per-project ledger into a per-crew one and lets `crew tasks` attach cost to each row.
