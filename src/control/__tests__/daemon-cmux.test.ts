import { describe, it, expect } from "vitest";
import { DaemonCmux } from "../cmux/daemon-cmux.js";
import { DeferDelivery } from "../../runtimes/cmux.js";

describe("DaemonCmux", () => {
  it("listSurfaces failure returns [] (never throws into the caller)", async () => {
    const driver = { listSurfaces: async () => { throw new Error("socket down"); } } as any;
    const dc = new DaemonCmux(driver);
    await expect(dc.listSurfaces("ws1")).resolves.toEqual([]);
  });

  it("readScreen failure returns null", async () => {
    const driver = { readScreen: async () => { throw new Error("nope"); } } as any;
    const dc = new DaemonCmux(driver);
    await expect(dc.readScreen("surface:1")).resolves.toBeNull();
  });

  it("send re-throws DeferDelivery (so the delivery loop can defer), swallows other errors", async () => {
    const deferDriver = { sendToSurface: async () => { throw new DeferDelivery("draft"); } } as any;
    await expect(new DaemonCmux(deferDriver).send({ ref: "s" } as any, "hi")).rejects.toBeInstanceOf(DeferDelivery);
    const errDriver = { sendToSurface: async () => { throw new Error("boom"); } } as any;
    await expect(new DaemonCmux(errDriver).send({ ref: "s" } as any, "hi")).resolves.toBeUndefined();
  });

  it("isAvailable() is true when listSurfaces resolves, false when it throws", async () => {
    expect(await new DaemonCmux({ listSurfaces: async () => [] } as any).isAvailable()).toBe(true);
    expect(await new DaemonCmux({ listSurfaces: async () => { throw new Error(); } } as any).isAvailable()).toBe(false);
  });
});
