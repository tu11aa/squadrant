# src/control/daemon/

Driver-agnostic daemon core. Contains all logic that does not depend on
concrete agent drivers (CodexInteractiveDriver, DaemonCmux, headless-launcher,
etc.). Those live in the host (`cockpitd.ts`).

## Owns

| File | Responsibility |
|------|----------------|
| `start.ts` | `startDaemon(ctx, opts, pkgVersion)` — wires all factories, runs boot recovery, starts timers, returns `DaemonHandle` |
| `context.ts` | `DaemonContext` shared state bag + `buildContext(opts)` + `CockpitdOpts` type |
| `attach.ts` | `createAttach(ctx)` — broadcast fan-out + gate-promotion timers |
| `probes.ts` | `createProbes(ctx)` — relay-proxy and daemon-direct surface-liveness probes |
| `delivery.ts` | `createDelivery(ctx, ...)` — mailbox append + daemon-direct captain delivery loop (#332) |
| `gates.ts` | `createGateResolver(ctx)` — routes captain approve/deny to the owning driver |
| `server.ts` | `createServer(ctx, handlers)` — IPC socket server + message router |
| `snapshot-gather.ts` | Pure I/O helpers for the dashboard snapshot (log stats, store stats, results) |

## Public Interface

```typescript
import { startDaemon } from "./daemon/start.js";
// ctx must have: attach handlers, codexDriver, opencodeBridge,
// cmuxEventsBridge, daemonCmux, daemonDirectCmux already set.
const handle = startDaemon(ctx, opts, pkgVersion);
```

## Depends On

- `../daemon.ts` (`createDaemon`) — state machine
- `../protocol.ts` — IPC framing
- `../mailbox.ts` — mailbox I/O
- `../liveness.ts` — health assembly
- `../snapshot.ts` — dashboard snapshot assembly
- `../relay-healer.ts` — relay health
- `@cockpit/shared` — types, config, constants

## Doesn't Belong Here

Concrete driver classes (`CodexInteractiveDriver`, `OpencodeSseBridge`,
`CmuxEventsBridge`, `DaemonCmux`), `headless-launcher`, and `runtimes/index`
all live in the host (`cockpitd.ts`). Importing them here would break the
driver-agnostic boundary verified by the Task-9 grep gate.
