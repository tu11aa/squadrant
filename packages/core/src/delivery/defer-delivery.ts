/** #617: the classification sendToSurface already decides at each throw site —
 *  surfaced so callers can log *why* a send deferred, not just that it did.
 *  "no-box": read-screen succeeded but the input box was not confirmed
 *            visible (overlay/menu/scrolled, #268).
 *  "modal": an AskUserQuestion/permission selection modal is open (#484).
 *  "draft": a real (or not-yet-disambiguated) draft is present in the input box.
 *  "probe-failed": the screen probe itself failed (dead surface, cmux down,
 *  bad ref, #714) — an infrastructure failure, never a UI condition.
 *  "no-channel" (#786): this captain's delivery transport is missing — no launch
 *  record / no control channel for its agent. Distinct from every UI condition:
 *  no amount of pane probing can clear it, so it alerts instead of scraping. */
export type DeferReason = "no-box" | "modal" | "draft" | "probe-failed" | "no-channel";

/** Thrown by sendToSurface when the captain has a draft — delivery defers (#258/#302). */
export class DeferDelivery extends Error {
  constructor(
    public readonly draft: string | null = null,
    public readonly reason: DeferReason = "draft",
  ) {
    super("deferred: captain composing");
    this.name = "DeferDelivery";
  }
}
