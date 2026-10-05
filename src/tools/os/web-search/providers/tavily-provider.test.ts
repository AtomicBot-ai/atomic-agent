import { describe, expect, it } from "vitest";

import { createTavilyProvider, parseTavilyJson } from "./tavily-provider.js";

describe("parseTavilyJson", () => {
  it("normalises Tavily results", () => {
    const body = JSON.stringify({
      results: [
        {
          title: "Tavily Result",
          url: "https://example.com/tavily",
          content: "Tavily snippet",
          publishedDate: "2026-08-24",
        },
        {
          title: "No Date",
          url: "https://example.com/no-date",
          content: "Snippet without a date",
        },
      ],
    });

    expect(parseTavilyJson(body, 5)).toEqual([
      {
        title: "Tavily Result",
        url: "https://example.com/tavily",
        snippet: "Tavily snippet",
        published: "2026-08-24",
      },
      {
        title: "No Date",
        url: "https://example.com/no-date",
        snippet: "Snippet without a date",
      },
    ]);
  });

  it("drops entries without a string title or url", () => {
    const body = JSON.stringify({
      results: [
        { url: "https://example.com/no-title", content: "snippet" },
        { title: 42, url: "https://example.com/bad-title" },
        { title: "Kept", url: "https://example.com/kept", content: 7 },
      ],
    });

    expect(parseTavilyJson(body, 5)).toEqual([
      {
        title: "Kept",
        url: "https://example.com/kept",
        snippet: "",
      },
    ]);
  });

  it("caps results at maxResults", () => {
    const body = JSON.stringify({
      results: [
        { title: "One", url: "https://example.com/1" },
        { title: "Two", url: "https://example.com/2" },
        { title: "Three", url: "https://example.com/3" },
      ],
    });

    expect(parseTavilyJson(body, 2)).toHaveLength(2);
  });

  it("returns empty for a body without a results array", () => {
    expect(parseTavilyJson(JSON.stringify({ detail: "error" }), 5)).toEqual([]);
    expect(parseTavilyJson(JSON.stringify({ results: "nope" }), 5)).toEqual([]);
  });
});

describe("createTavilyProvider", () => {
  it("throws before any request when the key env var is unset", async () => {
    const provider = createTavilyProvider({
      endpoint: "https://api.tavily.com/search",
      apiKeyEnv: "TAVILY_TEST_KEY",
    });
    const options = {
      query: "q",
      maxResults: 5,
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
    };

    delete process.env.TAVILY_TEST_KEY;
    await expect(provider.search(options)).rejects.toThrow(
      /TAVILY_TEST_KEY/,
    );
  });
});
