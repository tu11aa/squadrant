/**
 * The single LifecycleSource facade. Owns identity stamping, the flight
 * recorder, invariant evaluation, and the fact-to-ControlEvent boundary.
 *
 * Adapters know nothing about crews, seq numbers, or the daemon. They translate.
 */
import type { ControlEvent } from "@squadrant/shared";
import type {
  CorrelationHint, LifecycleSource, LifecycleSourceDeps,
} from "../lifecycle-source.js";
import type { AgentFact, FactAdapter, FactSource, RawFact } from "./fact.js";
import { stampFact } from "./fact.js";
import { FactLog } from "./log.js";
import { checkFact, freshTrace } from "./invariant.js";
import type { CheckOptions, CrewTrace, Violation } from "./invariant.js";
import { toControlEvent } from "./to-control-event.js";

export interface EventsSourceOptions {
  adapters: FactAdapter[];
  /** Ingress into the daemon's event pipeline. */
  emit: (ev: ControlEvent) => void;
  onViolation: (v: Violation) => void;
  /** Injected for determinism in tests. */
  now?: () => number;
  capacity?: number;
  check?: CheckOptions;
  log?: (msg: string) => void;
}

export interface EventsSource extends LifecycleSource {
  /** Feed one raw frame from a named adapter. Never throws. */
  ingest(source: FactSource, raw: unknown, hint: CorrelationHint): void;
  /** Flight-recorder read-out for one crew. */
  recent(taskId: string): AgentFact[];
  /** Newline-delimited JSON dump for one crew. */
  dump(taskId: string): string;
}

export function createEventsSource(opts: EventsSourceOptions): EventsSource {
  const now = opts.now ?? (() => Date.now());
  const log = new FactLog({ capacity: opts.capacity });
  const adapters = new Map(opts.adapters.map((a) => [a.name, a]));
  const traces = new Map<string, CrewTrace>();
  const seqs = new Map<string, number>();
  let deps: LifecycleSourceDeps | undefined;

  const traceFor = (taskId: string): CrewTrace => {
    let t = traces.get(taskId);
    if (!t) { t = freshTrace(); traces.set(taskId, t); }
    return t;
  };

  const nextSeq = (taskId: string): number => {
    const n = seqs.get(taskId) ?? 0;
    seqs.set(taskId, n + 1);
    return n;
  };

  return {
    name: "events",

    start(d) { deps = d; },
    stop() { deps = undefined; },

    health() { return { active: deps !== undefined, error: null }; },

    recent(taskId) { return log.recent(taskId); },
    dump(taskId) { return log.serialize(taskId); },

    ingest(source, raw, hint) {
      const adapter = adapters.get(source);
      if (!adapter || !deps) return;

      const rec = deps.resolve(hint);
      if (!rec) return;
      const taskId = rec.id;
      const at = now();

      // Containment: a broken adapter never kills the source (spec §8).
      let produced: RawFact[];
      try {
        const out = adapter.translate(raw);
        produced = Array.isArray(out) ? out : [{ kind: "unknown", name: `${source} returned non-array` }];
      } catch (e) {
        opts.log?.(`events: adapter ${source} threw: ${String(e)}`);
        produced = [{ kind: "unknown", name: `${source} threw` }];
      }

      for (const rawFact of produced) {
        const fact = stampFact(rawFact, {
          seq: nextSeq(taskId), taskId, at, source, origin: adapter.origin,
        });
        log.push(fact);
        for (const v of checkFact(traceFor(taskId), fact, opts.check ?? {})) {
          opts.onViolation(v);
        }
        for (const ev of toControlEvent(fact)) opts.emit(ev);
      }
    },
  };
}
