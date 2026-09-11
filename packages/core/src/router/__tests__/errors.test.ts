import { describe, it, expect } from "vitest";
import { anthropicError } from "../errors.js";

describe("anthropicError", () => {
  it("builds the Anthropic error envelope", () => {
    expect(anthropicError(401, "authentication_error", "nope")).toEqual({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "nope" } },
    });
  });
});
