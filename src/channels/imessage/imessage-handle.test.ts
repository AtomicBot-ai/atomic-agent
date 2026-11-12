import { describe, expect, it } from "vitest";

import {
  isOwnerHandle,
  maskHandle,
  normalizeHandle,
  normalizeOwnerIds,
} from "./imessage-handle.js";

describe("normalizeHandle", () => {
  it("strips spaces, dashes, dots and parentheses from phone numbers", () => {
    expect(normalizeHandle("+1 (415) 555-1212")).toBe("+14155551212");
    expect(normalizeHandle(" +44 20.7946.0958 ")).toBe("+442079460958");
    expect(normalizeHandle("tel:+14155551212")).toBe("+14155551212");
  });

  it("lower-cases Apple ID e-mails", () => {
    expect(normalizeHandle("Owner@iCloud.com")).toBe("owner@icloud.com");
    expect(normalizeHandle("mailto:Owner@iCloud.com")).toBe("owner@icloud.com");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeHandle("   ")).toBe("");
  });
});

describe("isOwnerHandle", () => {
  const owners = normalizeOwnerIds(["+1 (415) 555-1212", "Me@Example.com", " "]);

  it("matches the owner however the number was written", () => {
    expect(owners).toEqual(["+14155551212", "me@example.com"]);
    expect(isOwnerHandle("+14155551212", owners)).toBe(true);
    expect(isOwnerHandle("me@example.com", owners)).toBe(true);
  });

  it("never matches on a suffix of the owner's number", () => {
    // A looser rule would let any number ending in the same digits in.
    expect(isOwnerHandle("+4155551212", owners)).toBe(false);
    expect(isOwnerHandle("+194155551212", owners)).toBe(false);
  });

  it("refuses everyone when no owner is configured", () => {
    expect(isOwnerHandle("+14155551212", [])).toBe(false);
    expect(isOwnerHandle("", owners)).toBe(false);
  });
});

describe("maskHandle", () => {
  it("keeps only the e-mail domain or the last two digits", () => {
    expect(maskHandle("+14155551212")).toBe("***12");
    expect(maskHandle("me@example.com")).toBe("***@example.com");
    expect(maskHandle("")).toBe("<none>");
  });
});
