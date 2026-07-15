import { describe, expect, it } from "vitest";

import { sanitizeModelAlias } from "./sanitize-model-alias.js";

describe("sanitizeModelAlias", () => {
  it("returns null for a null alias", () => {
    expect(sanitizeModelAlias(null)).toBeNull();
  });

  it("returns null for a blank alias", () => {
    expect(sanitizeModelAlias("   ")).toBeNull();
  });

  it("lowercases and hyphenates whitespace", () => {
    expect(sanitizeModelAlias("Gemma 4 Think")).toBe("gemma-4-think");
  });

  it("lowercases a single-letter alias", () => {
    expect(sanitizeModelAlias("A")).toBe("a");
  });

  it("preserves the allowed charset", () => {
    expect(sanitizeModelAlias("qwen-3.5_think")).toBe("qwen-3.5_think");
  });

  it("drops disallowed characters", () => {
    expect(sanitizeModelAlias("model@v1!")).toBe("modelv1");
  });

  it("returns null when only disallowed characters remain", () => {
    expect(sanitizeModelAlias("@@@")).toBeNull();
  });

  it("caps the length at 64 characters", () => {
    expect(sanitizeModelAlias("a".repeat(100))).toHaveLength(64);
  });
});
