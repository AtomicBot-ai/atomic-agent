import { describe, expect, it } from "vitest";

import { resolveOhMyPiOptions } from "./import-options.js";

describe("resolveOhMyPiOptions", () => {
  it("defaults to every domain in registry order", () => {
    expect(resolveOhMyPiOptions()).toEqual(["skills", "mcp", "sessions"]);
  });

  it("applies include and exclude, exclude winning", () => {
    expect(resolveOhMyPiOptions({ exclude: ["mcp"] })).toEqual([
      "skills",
      "sessions",
    ]);
    expect(
      resolveOhMyPiOptions({ include: ["mcp"], exclude: ["mcp", "skills"] }),
    ).toEqual(["sessions"]);
  });

  it("rejects unknown ids", () => {
    expect(() => resolveOhMyPiOptions({ include: ["secrets"] })).toThrowError(
      /unknown option in --include: secrets/,
    );
    expect(() => resolveOhMyPiOptions({ exclude: ["memory"] })).toThrowError(
      /unknown option in --exclude: memory/,
    );
  });
});
