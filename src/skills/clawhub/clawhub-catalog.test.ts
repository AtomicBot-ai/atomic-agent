import { describe, expect, it } from "vitest";
import type { ClawHubClient, ClawHubSkillSummary } from "./clawhub-client.js";
import { browseClawHub, searchClawHub } from "./clawhub-catalog.js";

function summary(
  slug: string,
  downloads: number,
  ownerHandle: string | null = "alice",
): ClawHubSkillSummary {
  return {
    slug,
    ownerHandle,
    displayName: slug,
    summary: `${slug} summary`,
    version: "1.0.0",
    downloads,
  };
}

function fakeClient(results: ClawHubSkillSummary[]): ClawHubClient {
  return {
    async search() {
      return results;
    },
    async browse() {
      return { items: results, nextCursor: null };
    },
  } as unknown as ClawHubClient;
}

describe("searchClawHub", () => {
  it("sorts results by downloads descending and carries the count", async () => {
    const client = fakeClient([
      summary("low", 10),
      summary("high", 9000),
      summary("mid", 500),
    ]);
    const entries = await searchClawHub(client, "x");
    expect(entries.map((e) => e.identifier)).toEqual([
      "@alice/high",
      "@alice/mid",
      "@alice/low",
    ]);
    expect(entries[0]?.downloads).toBe(9000);
    expect(entries.every((e) => e.source === "clawhub")).toBe(true);
  });

  it("keeps relevance order for ties (stable sort)", async () => {
    const client = fakeClient([
      summary("first", 100),
      summary("second", 100),
    ]);
    const entries = await searchClawHub(client, "x");
    expect(entries.map((e) => e.identifier)).toEqual([
      "@alice/first",
      "@alice/second",
    ]);
  });
});

describe("browseClawHub", () => {
  it("maps rows preserving the server order", async () => {
    const client = fakeClient([summary("b", 1), summary("a", 99)]);
    const entries = await browseClawHub(client);
    expect(entries.map((e) => e.identifier)).toEqual(["@alice/b", "@alice/a"]);
    expect(entries[1]?.downloads).toBe(99);
  });
});
