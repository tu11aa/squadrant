/** Thrown by sendToSurface when the captain has a draft — delivery defers (#258/#302). */
export class DeferDelivery extends Error {
  constructor(public readonly draft: string | null = null) {
    super("deferred: captain composing");
    this.name = "DeferDelivery";
  }
}
