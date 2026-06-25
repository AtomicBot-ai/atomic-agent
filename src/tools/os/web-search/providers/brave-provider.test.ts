import { describe, expect, it } from "vitest";

import { parseBraveJson } from "./brave-provider.js";

describe("parseBraveJson", () => {
  it("normalises Brave web results", () => {
    const body = JSON.stringify({
      web: {
        results: [
          {
            title: "Brave Result",
            url: "https://example.com/brave",
            description: "Brave snippet",
            age: "2 days ago",
          },
        ],
      },
    });

    expect(parseBraveJson(body, 5)).toEqual([
      {
        title: "Brave Result",
        url: "https://example.com/brave",
        snippet: "Brave snippet",
        published: "2 days ago",
      },
    ]);
  });
});
