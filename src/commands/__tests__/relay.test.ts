import { describe, it, expect, vi } from "vitest";
import { buildRelaySuperviseArgs } from "../relay.js";

describe("relay supervise", () => {
  it("buildRelaySuperviseArgs returns correct runNotifyRelay opts for a project", () => {
    const config = {
      projects: {
        brove: {
          captainName: "brove-captain",
          path: "/tmp/brove",
        },
      },
    };

    const opts = buildRelaySuperviseArgs({
      project: "brove",
      subscriber: "captain",
      config: config as never,
      stateRoot: "/tmp/state",
    });

    expect(opts.project).toBe("brove");
    expect(opts.subscriber).toBe("captain");
    expect(opts.captainName).toBe("brove-captain");
    expect(opts.stateRoot).toBe("/tmp/state");
  });

  it("buildRelaySuperviseArgs defaults subscriber to 'captain'", () => {
    const config = {
      projects: {
        brove: {
          captainName: "brove-captain",
          path: "/tmp/brove",
        },
      },
    };

    const opts = buildRelaySuperviseArgs({
      project: "brove",
      config: config as never,
      stateRoot: "/tmp/state",
    });

    expect(opts.subscriber).toBe("captain");
  });

  it("throws for unknown project", () => {
    const config = { projects: {} };

    expect(() =>
      buildRelaySuperviseArgs({
        project: "nope",
        config: config as never,
        stateRoot: "/tmp/state",
      }),
    ).toThrow(/unknown project/);
  });
});
