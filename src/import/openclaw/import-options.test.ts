import { describe, expect, it } from "vitest";
import {
  OpenclawOptionError,
  resolveOpenclawOptions,
} from "./import-options.js";

describe("resolveOpenclawOptions", () => {
  it("defaults to sessions + cron", () => {
    expect(resolveOpenclawOptions()).toEqual(["sessions", "cron"]);
  });

  it("excludes cron", () => {
    expect(resolveOpenclawOptions({ exclude: ["cron"] })).toEqual(["sessions"]);
  });

  it("is idempotent on include of an already-selected option", () => {
    expect(resolveOpenclawOptions({ include: ["sessions"] })).toEqual([
      "sessions",
      "cron",
    ]);
  });

  it("ignores blank tokens", () => {
    expect(resolveOpenclawOptions({ exclude: ["  "] })).toEqual([
      "sessions",
      "cron",
    ]);
  });

  it("throws on an unknown include option", () => {
    expect(() => resolveOpenclawOptions({ include: ["secrets"] })).toThrow(
      OpenclawOptionError,
    );
  });

  it("throws on an unknown exclude option", () => {
    expect(() => resolveOpenclawOptions({ exclude: ["bogus"] })).toThrow(
      OpenclawOptionError,
    );
  });

  it("preserves registry order", () => {
    expect(resolveOpenclawOptions({ include: ["cron", "sessions"] })).toEqual([
      "sessions",
      "cron",
    ]);
  });
});
