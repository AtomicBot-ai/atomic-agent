import { describe, expect, it } from "vitest";

import { secretEquals } from "./secret-equal.js";

describe("secretEquals", () => {
  it("matches an identical secret", () => {
    expect(secretEquals("sekret", "sekret")).toBe(true);
  });

  it("matches identical non-ASCII secrets", () => {
    expect(secretEquals("pässwörd", "pässwörd")).toBe(true);
  });

  it("rejects a same-length mismatch", () => {
    expect(secretEquals("sekreT", "sekret")).toBe(false);
  });

  it("rejects a different-length value without throwing", () => {
    expect(secretEquals("sek", "sekret")).toBe(false);
    expect(secretEquals("sekret-and-more", "sekret")).toBe(false);
  });

  it("rejects values whose UTF-8 byte lengths differ", () => {
    expect(secretEquals("é", "e")).toBe(false);
  });

  it("rejects a missing or empty value", () => {
    expect(secretEquals(null, "sekret")).toBe(false);
    expect(secretEquals(undefined, "sekret")).toBe(false);
    expect(secretEquals("", "sekret")).toBe(false);
  });

  it("never matches an empty expected secret", () => {
    expect(secretEquals("", "")).toBe(false);
  });
});
