import type { RuntimeDriver, PaneRef } from "../../runtimes/types";
import { DeferDelivery } from "../../runtimes/cmux";

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
}
