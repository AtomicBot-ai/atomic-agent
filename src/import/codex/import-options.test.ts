import { describe, expect, it } from "vitest";

import { CodexOptionError, resolveCodexOptions } from "./import-options.js";

describe("resolveCodexOptions", () => {
  it("defaults to every non-secret option", () => {
    expect(resolveCodexOptions()).toEqual(["skills", "memory", "sessions"]);
  });

  it("applies exclude and keeps registry order", () => {
    expect(resolveCodexOptions({ exclude: ["memory"] })).toEqual([
      "skills",
      "sessions",
    ]);
  });

  it("adds secrets only through the explicit flag", () => {
    expect(resolveCodexOptions({ migrateSecrets: true })).toContain("secrets");
    expect(() => resolveCodexOptions({ include: ["secrets"] })).toThrow(
      CodexOptionError,
    );
  });

  it("rejects unknown option ids", () => {
    expect(() => resolveCodexOptions({ include: ["mcp"] })).toThrow(
      CodexOptionError,
    );
  });
});
