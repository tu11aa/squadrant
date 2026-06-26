import { describe, it, expect } from "vitest";
import { DaemonCmux } from "@squadrant/workspaces";
import { DeferDelivery } from "@squadrant/core";

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

  it("findWorkspaceId returns workspace ID when found, null when not found or error", async () => {
    const found = await new DaemonCmux({ status: async () => ({ id: "ws:42" }) } as any).findWorkspaceId("captain");
    expect(found).toBe("ws:42");

    const miss = await new DaemonCmux({ status: async () => null } as any).findWorkspaceId("ghost");
    expect(miss).toBeNull();

    const err = await new DaemonCmux({ status: async () => { throw new Error("gone"); } } as any).findWorkspaceId("err");
    expect(err).toBeNull();
  });
});
