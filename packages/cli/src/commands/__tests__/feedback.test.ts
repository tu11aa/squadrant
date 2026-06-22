import { describe, it, expect } from "vitest";
import { buildIssueUrl } from "../feedback.js";

describe("buildIssueUrl", () => {
  it("embeds the supplied squadrant version, not a hardcoded one", () => {
    const url = buildIssueUrl({}, "0.9.1");
    const body = decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
    expect(body).toContain("squadrant: 0.9.1");
    expect(body).not.toContain("0.1.0");
  });

  it("reflects whatever version it is given", () => {
    const body = decodeURIComponent(
      new URL(buildIssueUrl({}, "1.2.3")).searchParams.get("body") ?? "",
    );
    expect(body).toContain("squadrant: 1.2.3");
  });
});
