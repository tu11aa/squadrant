import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { workspaceRoot, workspacePath, archiveRoot, WORKSPACE_SUBDIRS } from "../workspace.js";

describe("workspace paths (#983 6b)", () => {
  const saved = { ws: process.env.SQUADRANT_WORKSPACE_DIR, ar: process.env.SQUADRANT_ARCHIVE_DIR };
  afterEach(() => {
    process.env.SQUADRANT_WORKSPACE_DIR = saved.ws;
    process.env.SQUADRANT_ARCHIVE_DIR = saved.ar;
  });

  it("defaults to ~/squadrant/workspace/<p> and ~/squadrant/archive", () => {
    delete process.env.SQUADRANT_WORKSPACE_DIR;
    delete process.env.SQUADRANT_ARCHIVE_DIR;
    expect(workspaceRoot()).toBe(path.join(os.homedir(), "squadrant", "workspace"));
    expect(workspacePath("flooros")).toBe(path.join(os.homedir(), "squadrant", "workspace", "flooros"));
    expect(archiveRoot()).toBe(path.join(os.homedir(), "squadrant", "archive"));
  });

  it("honours SQUADRANT_WORKSPACE_DIR and SQUADRANT_ARCHIVE_DIR", () => {
    process.env.SQUADRANT_WORKSPACE_DIR = "/tmp/ws";
    process.env.SQUADRANT_ARCHIVE_DIR = "/tmp/ar";
    expect(workspacePath("squadrant")).toBe("/tmp/ws/squadrant");
    expect(archiveRoot()).toBe("/tmp/ar");
  });

  it("lists the K7 exchange subdirs", () => {
    expect(WORKSPACE_SUBDIRS).toEqual(["handoffs", "side-handoffs", "inbox", "artifacts"]);
  });

  it("the test setup never points at the real home", () => {
    expect(saved.ws).toBeTruthy();
    expect(saved.ar).toBeTruthy();
    expect(saved.ws!.startsWith(os.homedir() + path.sep + "squadrant")).toBe(false);
  });
});
