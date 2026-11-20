import { describe, expect, it } from "vitest";

import { parseStartBody } from "./route-import-facts.js";

describe("POST /api/import/facts/start body (ATO-1617)", () => {
  it("defaults to the local model", () => {
    expect(parseStartBody({ source: "claude", path: "/tmp/export.zip" })).toEqual({
      source: "claude",
      path: "/tmp/export.zip",
      engine: { kind: "local" },
    });
  });

  it("counts only a literal true as cloud consent", () => {
    expect(parseStartBody({ source: "chatgpt", path: "/x", engine: { kind: "cloud", provider: "openrouter", cloudConsent: "yes" } })).toMatchObject({
      engine: { kind: "cloud", provider: "openrouter", cloudConsent: false },
    });
    expect(parseStartBody({ source: "chatgpt", path: "/x", engine: { kind: "cloud", provider: "openrouter", cloudConsent: true } })).toMatchObject({
      engine: { cloudConsent: true },
    });
  });

  it("refuses a bad body with a reason", () => {
    expect(parseStartBody(null)).toBeTypeOf("string");
    expect(parseStartBody({ source: "gemini", path: "/x" })).toMatch(/source/);
    expect(parseStartBody({ source: "claude", path: "relative.zip" })).toMatch(/absolute/);
    expect(parseStartBody({ source: "claude", path: "/x", engine: { kind: "cloud" } })).toMatch(/provider/);
    expect(parseStartBody({ source: "claude", path: "/x", engine: { kind: "magic" } })).toMatch(/kind/);
  });
});
