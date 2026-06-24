import { describe, expect, it } from "vitest";

import { parseSearxngJson } from "./searxng-provider.js";

describe("parseSearxngJson", () => {
  it("normalises SearXNG JSON results", () => {
    const body = JSON.stringify({
      results: [
        {
          title: "Result One",
          url: "https://example.com/one",
          content: "Snippet one",
          publishedDate: "2026-06-24",
        },
      ],
    });

    expect(parseSearxngJson(body, 5)).toEqual([
      {
        title: "Result One",
        url: "https://example.com/one",
        snippet: "Snippet one",
        published: "2026-06-24",
      },
    ]);
  });
});
