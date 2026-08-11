import { describe, expect, it } from "vitest";

import { addLink, moveLink, removeLink } from "./fallback-chain-edits.js";
import type { FallbackLinkRow } from "./fallback-panel-state.js";

function link(
  providerId: string,
  over: Partial<FallbackLinkRow> = {},
): FallbackLinkRow {
  return {
    providerId,
    modelLabel: null,
    kind: "openrouter",
    isActive: false,
    isAppendedLocal: false,
    ...over,
  };
}

/** Effective chain: active head, one middle, one plain, appended local. */
const links: FallbackLinkRow[] = [
  link("cloud-a", { isActive: true }),
  link("cloud-b"),
  link("cloud-c"),
  link("local-llama", { kind: "llama-server", isAppendedLocal: true }),
];

describe("moveLink", () => {
  it("moves a link down within the declared chain", () => {
    expect(moveLink(links, "cloud-b", 1).chain).toEqual([
      "cloud-a",
      "cloud-c",
      "cloud-b",
    ]);
  });

  it("moves a link up within the declared chain", () => {
    expect(moveLink(links, "cloud-c", -1).chain).toEqual([
      "cloud-a",
      "cloud-c",
      "cloud-b",
    ]);
  });

  it("clamps a move past the top to a no-op", () => {
    expect(moveLink(links, "cloud-a", -1).chain).toBeNull();
  });

  it("clamps a move past the last reorderable link to a no-op", () => {
    // cloud-c is the last declared entry (local is appended, not declared).
    expect(moveLink(links, "cloud-c", 1).chain).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    expect(moveLink(links, "nope", 1).chain).toBeNull();
  });
});

describe("addLink", () => {
  it("appends a new provider to the declared chain tail", () => {
    expect(addLink(links, "cloud-d").chain).toEqual([
      "cloud-a",
      "cloud-b",
      "cloud-c",
      "cloud-d",
    ]);
  });

  it("is a no-op when the provider is already a link", () => {
    expect(addLink(links, "cloud-b").chain).toBeNull();
  });
});

describe("removeLink", () => {
  it("drops a plain link from the declared chain", () => {
    expect(removeLink(links, "cloud-b").chain).toEqual(["cloud-a", "cloud-c"]);
  });

  it("refuses to remove the active head", () => {
    expect(removeLink(links, "cloud-a").chain).toBeNull();
  });

  it("refuses to remove the auto-appended local link", () => {
    expect(removeLink(links, "local-llama").chain).toBeNull();
  });

  it("refuses to empty the declared chain", () => {
    const single: FallbackLinkRow[] = [link("cloud-a", { isActive: true })];
    expect(removeLink(single, "cloud-a").chain).toBeNull();
  });
});
