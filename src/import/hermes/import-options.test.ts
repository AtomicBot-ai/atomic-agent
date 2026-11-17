import { describe, expect, it } from "vitest";
import { ImportOptionError, resolveSelectedOptions } from "./import-options.js";

describe("resolveSelectedOptions", () => {
  it("defaults to the 'default' preset (sessions + cron, no secrets)", () => {
    expect(resolveSelectedOptions()).toEqual(["sessions", "cron"]);
  });

  it("returns options in registry order regardless of input order", () => {
    const result = resolveSelectedOptions({
      preset: "default",
      include: ["cron"],
    });
    expect(result).toEqual(["sessions", "cron"]);
  });

  it("applies --exclude", () => {
    expect(resolveSelectedOptions({ exclude: ["cron"] })).toEqual(["sessions"]);
  });

  it("never includes secrets via preset, even 'full'", () => {
    expect(resolveSelectedOptions({ preset: "full" })).toEqual([
      "sessions",
      "cron",
    ]);
  });

  it("adds secrets only when migrateSecrets is true", () => {
    expect(resolveSelectedOptions({ migrateSecrets: true })).toEqual([
      "sessions",
      "cron",
      "secrets",
    ]);
  });

  it("rejects selecting secrets through --include", () => {
    expect(() => resolveSelectedOptions({ include: ["secrets"] })).toThrow(
      ImportOptionError,
    );
  });

  it("rejects an unknown include id", () => {
    expect(() => resolveSelectedOptions({ include: ["bogus"] })).toThrow(
      ImportOptionError,
    );
  });

  it("rejects an unknown exclude id", () => {
    expect(() => resolveSelectedOptions({ exclude: ["bogus"] })).toThrow(
      ImportOptionError,
    );
  });

  it("rejects an unknown preset", () => {
    expect(() => resolveSelectedOptions({ preset: "wat" as never })).toThrow(
      ImportOptionError,
    );
  });

  it("adds plugins only when at least one plugin is trusted", () => {
    expect(resolveSelectedOptions({ trustedPlugins: [] })).toEqual([
      "sessions",
      "cron",
    ]);
    expect(resolveSelectedOptions({ trustedPlugins: ["  "] })).toEqual([
      "sessions",
      "cron",
    ]);
    expect(
      resolveSelectedOptions({
        trustedPlugins: ["calculator"],
        exclude: ["sessions", "cron"],
      }),
    ).toEqual(["plugins"]);
  });

  it("never selects plugins via preset or --include", () => {
    expect(resolveSelectedOptions({ preset: "full" })).not.toContain("plugins");
    expect(() => resolveSelectedOptions({ include: ["plugins"] })).toThrow(
      ImportOptionError,
    );
  });
});
