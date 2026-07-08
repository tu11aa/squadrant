import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeDriver, PaneRef } from "../runtimes/types.js";
import { DeferDelivery } from "@squadrant/core";
import { loadConfig } from "@squadrant/shared";
import type { RuntimeLivenessRecord } from "@squadrant/shared";
import { parseStoreRecords } from "./store-fingerprint.js";

/**
 * #332: daemon-side cmux access. The daemon (a launchd process, NOT a cmux
 * descendant) can now drive cmux directly because the CLI auto-discovers its
 * canonical socket (~/.local/state/cmux/cmux.sock) from any process.
 *
 * Every method is FAIL-SOFT: a cmux/socket error degrades to a safe sentinel
 * ([] / null / no-op) so a transient failure NEVER false-reaps a live crew.
 * The ONE exception is DeferDelivery, which `send` re-throws so the delivery
 * loop can defer-while-typing (#258/#302).
 *
 * This is the seam #333's LifecycleSource port sits beside.
 */
export class DaemonCmux {
  constructor(private readonly driver: RuntimeDriver) {}

  async send(surface: PaneRef, text: string, opts?: { probe?: boolean }): Promise<void> {
    try {
      await this.driver.sendToSurface(surface, text, opts);
    } catch (e) {
      if (e instanceof DeferDelivery) throw e;
    }
  }

  async listSurfaces(workspaceId: string): Promise<PaneRef[]> {
    try { return await this.driver.listSurfaces(workspaceId); }
    catch { return []; }
  }

  async readScreen(ref: string): Promise<string | null> {
    try { return await this.driver.readScreen(ref); }
    catch { return null; }
  }

  async readPaneScreen(pane: PaneRef): Promise<string | null> {
    try { return await this.driver.readPaneScreen(pane); }
    catch { return null; }
  }

  async findWorkspaceId(name: string): Promise<string | null> {
    try {
      const ref = await this.driver.status(name);
      return ref?.id ?? null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try { await this.driver.listSurfaces(""); return true; }
    catch { return false; }
  }

  /** Ground-truth liveness from cmux's own hook-sessions store (§5.4). */
  async liveness(): Promise<RuntimeLivenessRecord[]> {
    const dir = process.env.CMUX_AGENT_HOOK_STATE_DIR ?? join(homedir(), ".cmuxterm");
    const projects = loadConfig().projects as Record<string, { path: string }>;
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith("-hook-sessions.json") && !f.endsWith(".lock")); }
    catch { return []; }
    const out: RuntimeLivenessRecord[] = [];
    for (const f of files) {
      try { out.push(...parseStoreRecords(readFileSync(join(dir, f), "utf-8"), projects)); }
      catch { /* skip unreadable/corrupt file */ }
    }
    return out;
  }
}
