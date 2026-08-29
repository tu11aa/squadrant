/**
 * The properties EVERY FactAdapter must satisfy, shipped with the seam so a new
 * adapter proves itself WITHOUT the daemon (spec §9).
 *
 * Runner-independent: returns named cases the caller drives with its own
 * `it()`. Assertions use plain throws so this file stays test-framework-free.
 */
import type { FactAdapter } from "./fact.js";

export interface ConformanceCase {
  name: string;
  run(): void;
}

/** Inputs no adapter may choke on. */
const GARBAGE: unknown[] = [
  null, undefined, 0, "", "not json", [], {}, { type: 42 },
  { type: "definitely-not-a-real-event-name" },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`conformance: ${msg}`);
}

/**
 * @param adapter the adapter under test
 * @param samples raw frames this adapter IS expected to recognise
 */
export function runAdapterConformance(
  adapter: FactAdapter,
  samples: unknown[],
): ConformanceCase[] {
  const call = (raw: unknown) => adapter.translate(raw);

  return [
    {
      name: `${adapter.name}: never throws on garbage`,
      run: () => {
        for (const g of GARBAGE) {
          try { call(g); }
          catch (e) { throw new Error(`threw on ${JSON.stringify(g)}: ${String(e)}`); }
        }
      },
    },
    {
      name: `${adapter.name}: never returns null or undefined`,
      run: () => {
        for (const g of [...GARBAGE, ...samples]) {
          const out = call(g);
          assert(Array.isArray(out), `returned a non-array for ${JSON.stringify(g)}`);
        }
      },
    },
    {
      name: `${adapter.name}: an unrecognised frame yields unknown, not an empty array`,
      run: () => {
        const out = call({ type: "definitely-not-a-real-event-name" });
        assert(out.length > 0, "silently dropped an unrecognised frame (the #542 shape)");
        assert(
          out.every((f) => f.kind === "unknown"),
          "an unrecognised frame must translate to kind 'unknown'",
        );
      },
    },
    {
      name: `${adapter.name}: recognises its own samples`,
      run: () => {
        for (const s of samples) {
          const out = call(s);
          assert(out.length > 0, `produced nothing for its own sample ${JSON.stringify(s)}`);
          assert(
            out.some((f) => f.kind !== "unknown"),
            `failed to recognise its own sample ${JSON.stringify(s)}`,
          );
        }
      },
    },
    {
      name: `${adapter.name}: declares a constant origin`,
      run: () => {
        assert(
          adapter.origin === "agent" || adapter.origin === "scan" || adapter.origin === "inferred",
          `invalid origin "${String(adapter.origin)}"`,
        );
      },
    },
  ];
}
