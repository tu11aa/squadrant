// src/control/telegram/__tests__/format.test.ts
import { describe, it, expect } from "vitest";
import { crewTopicName, inboundCaptainMessage } from "../format.js";

describe("telegram formatters", () => {
  it("crewTopicName prefixes the crew name with a wrench", () => {
    expect(crewTopicName("crew-2")).toBe("🔧 crew-2");
  });

  it("inboundCaptainMessage tags the source crew", () => {
    expect(inboundCaptainMessage("crew-2", "use lucia")).toBe("📩 [from Telegram · crew-2] use lucia");
  });

  it("inboundCaptainMessage handles a captain-topic reply (no task name)", () => {
    expect(inboundCaptainMessage(undefined, "status?")).toBe("📩 [from Telegram] status?");
  });
});
