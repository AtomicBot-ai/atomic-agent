import { afterEach, describe, expect, it, vi } from "vitest";

import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import {
  createExaProvider,
  extractExaText,
  parseExaApiJson,
  parseExaTextResults,
} from "./exa-provider.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";

const MARKER = "__ATOMIC_WEB_SEARCH_META__";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function curlStdout(body: string, status = 200): string {
  return `${body}\n${MARKER}${status}|application/json||${body.length}`;
}

describe("parseExaApiJson", () => {
  it("normalises keyed Exa API results", () => {
    const body = JSON.stringify({
      results: [
        {
          title: "Keyed Result",
          url: "https://example.com/keyed",
          highlights: ["Keyed snippet"],
          publishedDate: "2026-06-24",
        },
      ],
    });

    expect(parseExaApiJson(body, 5)).toEqual([
      {
        title: "Keyed Result",
        url: "https://example.com/keyed",
        snippet: "Keyed snippet",
        published: "2026-06-24",
      },
    ]);
  });
});

describe("createExaProvider", () => {
  it("uses the keyed Exa API when the configured env var is present", async () => {
    const previous = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "test-key";
    const calls: Array<{ args: string[]; input?: string }> = [];
    const runCommand = (async (
      _cmd: string,
      args: string[],
      opts: { input?: string },
    ) => {
      calls.push({ args, input: opts.input });
      return {
        command: "curl",
        args,
        exitCode: 0,
        signal: null,
        stdout: curlStdout(
          JSON.stringify({
            results: [
              { title: "A", url: "https://example.com", highlights: ["S"] },
            ],
          }),
        ),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }) as unknown as typeof RunCommandType;

    try {
      const provider = createExaProvider(
        {
          endpoint: "https://mcp.exa.ai/mcp",
          apiEndpoint: "https://api.exa.ai/search",
          apiKeyEnv: "EXA_API_KEY",
        },
        { runCommand, lookup: publicLookup },
      );
      const results = await provider.search({
        query: "atomic agent",
        maxResults: 3,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      });

      expect(results[0]?.title).toBe("A");
      expect(calls[0]?.args).toContain("https://api.exa.ai/search");
      expect(calls[0]?.args.join("\n")).toContain("x-api-key: test-key");
      expect(calls[0]?.input).toContain('"query":"atomic agent"');
    } finally {
      if (previous === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previous;
    }
  });
});

/**
 * ATO-327: the keyless tier may report its limit inside an HTTP 200, as a
 * JSON-RPC `error` or an `isError` result. It must read as a rate limit,
 * so the orchestrator parks Exa and asks for a key.
 */
describe("createExaProvider keyless limit inside a 200", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function searchKeyless(body: string): Promise<unknown> {
    vi.stubEnv("EXA_API_KEY", "");
    const runCommand = (async (_cmd: string, args: string[]) => ({
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: curlStdout(body),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;
    const provider = createExaProvider(
      {
        endpoint: "https://mcp.exa.ai/mcp",
        apiEndpoint: "https://api.exa.ai/search",
        apiKeyEnv: "EXA_API_KEY",
      },
      { runCommand, lookup: publicLookup },
    );
    return provider
      .search({
        query: "q",
        maxResults: 3,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      })
      .catch((err: unknown) => err);
  }

  it("reads a JSON-RPC rate-limit error as a rate limit", async () => {
    const err = await searchKeyless(
      JSON.stringify({
        error: {
          message:
            "Rate limit exceeded. Create API key at https://dashboard.exa.ai/api-keys",
        },
      }),
    );
    expect(err).toBeInstanceOf(WebSearchRateLimitedError);
  });

  it("reads an isError result about the limit as a rate limit", async () => {
    const err = await searchKeyless(
      JSON.stringify({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "Free tier limit hit. Create API key at https://dashboard.exa.ai/api-keys",
            },
          ],
        },
      }),
    );
    expect(err).toBeInstanceOf(WebSearchRateLimitedError);
  });

  it("leaves any other error a plain failure", async () => {
    const err = await searchKeyless(
      JSON.stringify({ error: { message: "Invalid params" } }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WebSearchRateLimitedError);
    expect((err as Error).message).toBe("Invalid params");
  });
});

describe("extractExaText", () => {
  it("extracts text content from Exa MCP SSE envelopes", () => {
    const body = [
      "event: message",
      'data: {"result":{"content":[{"type":"text","text":"Title: A\\nURL: https://example.com\\nHighlights:\\nSnippet"}]}}',
      "",
    ].join("\n");

    expect(extractExaText(body)).toContain("Title: A");
  });
});

describe("parseExaTextResults", () => {
  it("normalises Exa text blocks into search results", () => {
    const text = [
      "Title: A",
      "URL: https://example.com/a",
      "Published: 2026",
      "Highlights:",
      "Useful snippet.",
    ].join("\n");

    expect(parseExaTextResults(text, 5)).toEqual([
      {
        title: "A",
        url: "https://example.com/a",
        snippet: "Useful snippet.",
        published: "2026",
      },
    ]);
  });

  it("splits consecutive Title blocks even without blank lines", () => {
    const text = [
      "Title: A",
      "URL: https://example.com/a",
      "Highlights:",
      "Snippet A.",
      "Title: B",
      "URL: https://example.com/b",
      "Highlights:",
      "Snippet B.",
    ].join("\n");

    expect(parseExaTextResults(text, 5).map((result) => result.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});
