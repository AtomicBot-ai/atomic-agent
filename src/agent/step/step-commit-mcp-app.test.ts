import { describe, expect, it } from "vitest";

import { withoutMcpAppPage } from "./step-commit.js";

describe("session copy of an MCP App result (ATO-1135)", () => {
  it("leaves the page out and keeps every other detail", () => {
    const details = { structuredContent: { temp: 21 }, mcpApp: { resourceUri: "ui://a/b", html: "<p>x</p>" } };
    expect(withoutMcpAppPage(details)).toEqual({ structuredContent: { temp: 21 } });
    // The live result is not changed: the stream frame still reads the page.
    expect(details.mcpApp.html).toBe("<p>x</p>");
  });

  it("returns details without a page as they are", () => {
    const details = { exitCode: 0 };
    expect(withoutMcpAppPage(details)).toBe(details);
  });
});
