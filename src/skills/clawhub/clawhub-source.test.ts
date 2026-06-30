import { describe, expect, it } from "vitest";
import {
  ClawHubIdentifierError,
  formatClawHubIdentifier,
  looksLikeClawHubIdentifier,
  parseClawHubIdentifier,
} from "./clawhub-source.js";

describe("parseClawHubIdentifier", () => {
  it("parses the canonical @owner/slug form", () => {
    expect(parseClawHubIdentifier("@alice/pdf-tools")).toEqual({
      owner: "alice",
      slug: "pdf-tools",
    });
  });

  it("parses a bare slug as owner-less", () => {
    expect(parseClawHubIdentifier("pdf-tools")).toEqual({
      owner: null,
      slug: "pdf-tools",
    });
  });

  it("rejects an empty identifier", () => {
    expect(() => parseClawHubIdentifier("   ")).toThrow(ClawHubIdentifierError);
  });

  it("rejects a malformed @owner form without a slug", () => {
    expect(() => parseClawHubIdentifier("@alice")).toThrow(
      ClawHubIdentifierError,
    );
    expect(() => parseClawHubIdentifier("@alice/a/b")).toThrow(
      ClawHubIdentifierError,
    );
  });

  it("rejects a GitHub owner/repo identifier (bare slug must not contain /)", () => {
    expect(() => parseClawHubIdentifier("anthropics/skills")).toThrow(
      ClawHubIdentifierError,
    );
  });

  it("rejects an invalid owner", () => {
    expect(() => parseClawHubIdentifier("@-bad/slug")).toThrow(
      ClawHubIdentifierError,
    );
  });
});

describe("looksLikeClawHubIdentifier", () => {
  it("matches an explicit @owner/slug", () => {
    expect(looksLikeClawHubIdentifier("@alice/pdf")).toBe(true);
  });

  it("does NOT match a bare slug (avoids hijacking a local dir name)", () => {
    expect(looksLikeClawHubIdentifier("myskill")).toBe(false);
    expect(looksLikeClawHubIdentifier("anthropics/skills")).toBe(false);
  });
});

describe("formatClawHubIdentifier", () => {
  it("builds @owner/slug when the owner is known", () => {
    expect(formatClawHubIdentifier("alice", "pdf")).toBe("@alice/pdf");
  });

  it("falls back to the bare slug when the owner is unknown", () => {
    expect(formatClawHubIdentifier(null, "pdf")).toBe("pdf");
  });
});
