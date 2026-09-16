import { describe, expect, it } from "vitest";

import { resolvePiOptions } from "./import-options.js";

describe("resolvePiOptions", () => {
  it("defaults to every domain in registry order", () => {
    expect(resolvePiOptions()).toEqual(["skills", "sessions"]);
  });

  it("applies include and exclude, exclude winning", () => {
    expect(resolvePiOptions({ exclude: ["skills"] })).toEqual(["sessions"]);
    expect(
      resolvePiOptions({
        include: ["skills"],
        exclude: ["skills", "sessions"],
      }),
    ).toEqual([]);
  });

  it("rejects unknown ids", () => {
    expect(() => resolvePiOptions({ include: ["cron"] })).toThrowError(
      /unknown option in --include: cron/,
    );
    expect(() => resolvePiOptions({ exclude: ["mcp"] })).toThrowError(
      /unknown option in --exclude: mcp/,
    );
  });
});
