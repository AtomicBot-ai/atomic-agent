import { describe, expect, it } from "vitest";
import {
  createShellGuardDefaults,
  parseShellGuardConfig,
} from "./shell-guard-config.js";
import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  parseUserConfigFile,
} from "./config-schema.js";

function captureError(run: () => unknown): ConfigValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error("Expected a configuration validation error");
}

const defaults = createShellGuardDefaults();

describe("shellGuard config (v77, issue #229)", () => {
  it("defaults to empty lists, which mount no user layer", () => {
    expect(defaults).toEqual({ deny: [], allow: [] });
    expect(USER_CONFIG_DEFAULTS.shellGuard).toEqual({ deny: [], allow: [] });
    expect(parseShellGuardConfig({}, () => defaults)).toEqual({
      deny: [],
      allow: [],
    });
  });

  it("parses both lists and preserves order", () => {
    expect(
      parseShellGuardConfig(
        {
          deny: ["rm -rf *", "npm publish"],
          allow: ["npm run *", "git status"],
        },
        () => defaults,
      ),
    ).toEqual({
      deny: ["rm -rf *", "npm publish"],
      allow: ["npm run *", "git status"],
    });
  });

  it("trims patterns and drops duplicates (first occurrence wins)", () => {
    expect(
      parseShellGuardConfig(
        { deny: ["  npm publish  ", "npm publish", "cargo build"] },
        () => defaults,
      ),
    ).toEqual({ deny: ["npm publish", "cargo build"], allow: [] });
  });

  it("rejects non-arrays, non-strings and empty patterns by field path", () => {
    expect(captureError(() => parseShellGuardConfig({ deny: "npm *" }, () => defaults)).field).toBe(
      "shellGuard.deny",
    );
    expect(
      captureError(() => parseShellGuardConfig({ deny: [42] }, () => defaults))
        .field,
    ).toBe("shellGuard.deny[0]");
    expect(
      captureError(() =>
        parseShellGuardConfig({ allow: ["   "] }, () => defaults),
      ).field,
    ).toBe("shellGuard.allow[0]");
  });

  it("rejects oversized lists and patterns", () => {
    expect(
      captureError(() =>
        parseShellGuardConfig(
          { deny: Array.from({ length: 257 }, (_, i) => `cmd${i}`) },
          () => defaults,
        ),
      ).field,
    ).toBe("shellGuard.deny");
    expect(
      captureError(() =>
        parseShellGuardConfig({ allow: ["x".repeat(201)] }, () => defaults),
      ).field,
    ).toBe("shellGuard.allow[0]");
  });

  it("older files upgrade with empty lists and keep working", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION - 1,
      log: { level: "info" },
    });
    expect(parsed.shellGuard).toEqual({ deny: [], allow: [] });
  });

  it("round-trips through parseUserConfigFile", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      shellGuard: { deny: ["npm publish"], allow: ["npm run *"] },
    });
    expect(parsed.shellGuard).toEqual({
      deny: ["npm publish"],
      allow: ["npm run *"],
    });
  });

  it("rejects malformed lists through parseUserConfigFile with the file-level wrapper", () => {
    expect(
      captureError(() =>
        parseUserConfigFile({
          version: USER_CONFIG_VERSION,
          shellGuard: { deny: [true] },
        }),
      ).field,
    ).toBe("shellGuard.deny[0]");
  });
});
