import { describe, it, expect, vi } from "vitest";
import { restartAfterProjectsAdd } from "../projects.js";

describe("restartAfterProjectsAdd — restart gating", () => {
  it("calls restart helper with reason 'project registration'", () => {
    const spy = vi.fn().mockReturnValue("restarted");
    restartAfterProjectsAdd({ doRestart: spy });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({ reason: "project registration" });
  });

  it("passes noRestart=true through to the helper", () => {
    const spy = vi.fn().mockReturnValue("skipped-opt-out");
    restartAfterProjectsAdd({ noRestart: true, doRestart: spy });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({ noRestart: true });
  });
});
