import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeDriver, PaneRef } from "../runtimes/types.js";
import { DeferDelivery } from "@squadrant/core";
import { loadConfig } from "@squadrant/shared";
import type { RuntimeLivenessRecord } from "@squadrant/shared";
import { readLivenessSnapshot } from "./store-fingerprint.js";

/**
 * #332: daemon-side cmux access. The daemon (a launchd process, NOT a cmux
 * descendant) can now drive cmux directly because the CLI auto-discovers its
 * canonical socket (~/.local/state/cmux/cmux.sock) from any process.
 *
 * Every method is FAIL-SOFT: a cmux/socket error degrades to a safe sentinel
 * ([] / null / no-op) so a transient failure NEVER false-reaps a live crew.
 * Exceptions: DeferDelivery, which `send` re-throws so the delivery loop can
 * defer-while-typing (#258/#302); and `liveness()`, which THROWS when it
 * cannot get a good read of the store (readdir failure, or every store file
 * unreadable/corrupt) instead of returning [] — a locked/mid-write store must
 * never look like "read succeeded, zero captains" (that would false-close
 * every known captain via runLivenessTick's markEnded path). runLivenessTick
 * already treats a thrown liveness() as "leave the registry untouched".
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

  /**
   * Ground-truth liveness from cmux's own hook-sessions store (§5.4).
   * THROWS (does not return []) when the dir can't be listed, or every store
   * file failed to read/parse — see the class doc above.
   */
  async liveness(): Promise<RuntimeLivenessRecord[]> {
    const dir = process.env.CMUX_AGENT_HOOK_STATE_DIR ?? join(homedir(), ".cmuxterm");
    const projects = loadConfig().projects as Record<string, { path: string }>;
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith("-hook-sessions.json") && !f.endsWith(".lock")); }
    catch (e) { throw new Error(`liveness: could not read cmux state dir ${dir}: ${(e as Error).message}`); }
    return readLivenessSnapshot(files, (f) => readFileSync(join(dir, f), "utf-8"), projects);
  }
}
