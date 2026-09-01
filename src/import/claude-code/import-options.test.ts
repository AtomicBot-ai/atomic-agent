import { describe, expect, it } from "vitest";

import {
  ClaudeCodeOptionError,
  resolveClaudeCodeOptions,
} from "./import-options.js";

describe("resolveClaudeCodeOptions", () => {
  it("defaults to every non-secret option", () => {
    expect(resolveClaudeCodeOptions()).toEqual([
      "skills",
      "memory",
      "mcp",
      "sessions",
    ]);
  });

  it("applies exclude and keeps registry order", () => {
    expect(resolveClaudeCodeOptions({ exclude: ["sessions", "memory"] })).toEqual([
      "skills",
      "mcp",
    ]);
  });

  it("adds secrets only through the explicit flag", () => {
    expect(resolveClaudeCodeOptions({ migrateSecrets: true })).toContain("secrets");
    expect(() => resolveClaudeCodeOptions({ include: ["secrets"] })).toThrow(
      ClaudeCodeOptionError,
    );
  });

  it("rejects unknown option ids", () => {
    expect(() => resolveClaudeCodeOptions({ include: ["cron"] })).toThrow(
      ClaudeCodeOptionError,
    );
    expect(() => resolveClaudeCodeOptions({ exclude: ["nope"] })).toThrow(
      ClaudeCodeOptionError,
    );
  });
});
