import { describe, expect, it } from "vitest";

import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";
import {
  buildSearchBody,
  createAnySearchProvider,
  parseAnySearchJson,
  parseAnySearchResponse,
  redactSecrets,
  sanitizeResultUrl,
} from "./anysearch-provider.js";

const MARKER = "__ATOMIC_WEB_SEARCH_META__";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function curlStdout(body: string, status = 200): string {
  return `${body}\n${MARKER}${status}|application/json||${body.length}`;
}

const defaultConfig = {
  endpoint: "https://api.anysearch.com/v1/search",
  apiKeyEnv: "ANYSEARCH_API_KEY",
  zone: null as string | null,
  language: null as string | null,
};

describe("parseAnySearchJson", () => {
  it("normalises AnySearch REST results", () => {
    const body = JSON.stringify({
      code: 0,
      message: "success",
      request_id: "rid-ok",
      data: {
        results: [
          {
            title: "Go 1.26 Release Notes",
            url: "https://go.dev/doc/go1.26",
            snippet: "Introduction to the changes in Go 1.26.",
          },
          {
            title: "Skip me",
            url: "",
            snippet: "missing url",
          },
        ],
        metadata: { total_results: 1, search_time_ms: 12 },
      },
    });

    expect(parseAnySearchJson(body, 5)).toEqual([
      {
        title: "Go 1.26 Release Notes",
        url: "https://go.dev/doc/go1.26",
        snippet: "Introduction to the changes in Go 1.26.",
      },
    ]);
    expect(parseAnySearchResponse(body, 5).requestId).toBe("rid-ok");
  });

  it("falls back to content when snippet is absent", () => {
    const body = JSON.stringify({
      code: 0,
      data: {
        results: [
          {
            title: "A",
            url: "https://example.com",
            content: "Long   content   body",
          },
        ],
      },
    });
    expect(parseAnySearchJson(body, 1)[0]?.snippet).toBe("Long content body");
  });

  it("strips embedded userinfo from result URLs (OpenClaw hardening)", () => {
    const body = JSON.stringify({
      code: 0,
      data: {
        results: [
          {
            title: "Leak",
            url: "https://user:secret@example.com/path?q=1",
            snippet: "x",
          },
        ],
      },
    });
    expect(parseAnySearchJson(body, 1)[0]?.url).toBe(
      "https://example.com/path?q=1",
    );
  });

  it("throws on a non-zero business code and keeps request_id", () => {
    expect(() =>
      parseAnySearchJson(
        JSON.stringify({
          code: -1,
          message: "Query is required.",
          request_id: "abc",
        }),
        5,
      ),
    ).toThrow(/Query is required.*request_id: abc/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAnySearchJson("not-json", 5)).toThrow(/invalid JSON/);
  });
});

describe("buildSearchBody", () => {
  it("includes vertical routing and config defaults", () => {
    expect(
      buildSearchBody(
        {
          query: "AAPL",
          maxResults: 3,
          tag: "finance.quote",
          params: { type: "stock", symbol: "AAPL", cn_code: "" },
        },
        { zone: "intl", language: "en" },
      ),
    ).toEqual({
      query: "AAPL",
      max_results: 3,
      tag: "finance.quote",
      params: { type: "stock", symbol: "AAPL", cn_code: "" },
      zone: "intl",
      language: "en",
    });
  });

  it("lets per-call zone override config defaults", () => {
    expect(
      buildSearchBody(
        { query: "q", maxResults: 5, zone: "cn" },
        { zone: "intl", language: null },
      ).zone,
    ).toBe("cn");
  });
});

describe("redactSecrets", () => {
  it("strips bearer tokens and known keys", () => {
    expect(
      redactSecrets("Bearer as_sk_secret failed; as_sk_secret", "as_sk_secret"),
    ).toBe("Bearer [REDACTED] failed; [REDACTED]");
  });

  it("strips AnySearch key shapes and URL userinfo in error text", () => {
    expect(
      redactSecrets(
        "upstream https://user:as_sk_abc123@api.example/x as_sk_other",
      ),
    ).toBe(
      "upstream https://[REDACTED]@api.example/x as_sk_[REDACTED]",
    );
  });
});

describe("sanitizeResultUrl", () => {
  it("clears username/password from https URLs", () => {
    expect(sanitizeResultUrl("https://a:b@host/p")).toBe("https://host/p");
  });

  it("leaves clean URLs unchanged", () => {
    expect(sanitizeResultUrl("https://host/p")).toBe("https://host/p");
  });
});

describe("createAnySearchProvider", () => {
  it("sends an anonymous POST with the client attribution header", async () => {
    const previous = process.env.ANYSEARCH_API_KEY;
    delete process.env.ANYSEARCH_API_KEY;
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
            code: 0,
            data: {
              results: [
                {
                  title: "A",
                  url: "https://example.com",
                  snippet: "S",
                },
              ],
            },
          }),
        ),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }) as unknown as typeof RunCommandType;

    try {
      const provider = createAnySearchProvider(defaultConfig, {
        runCommand,
        lookup: publicLookup,
      });
      const results = await provider.search({
        query: "atomic agent",
        maxResults: 3,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      });

      expect(results.results[0]?.title).toBe("A");
      expect(calls[0]?.args).toContain("https://api.anysearch.com/v1/search");
      expect(calls[0]?.args.join("\n")).toMatch(
        /X-Anysearch-Client: atomic-agent\/web-search@/,
      );
      expect(calls[0]?.args.join("\n")).not.toContain("Authorization:");
      expect(calls[0]?.input).toContain('"query":"atomic agent"');
      expect(calls[0]?.input).toContain('"max_results":3');
    } finally {
      if (previous === undefined) delete process.env.ANYSEARCH_API_KEY;
      else process.env.ANYSEARCH_API_KEY = previous;
    }
  });

  it("surfaces request_id on a successful response", async () => {
    const runCommand = (async () => ({
      command: "curl",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: curlStdout(
        JSON.stringify({
          code: 0,
          request_id: "rid-success",
          data: {
            results: [
              {
                title: "A",
                url: "https://example.com",
                snippet: "S",
              },
            ],
          },
        }),
      ),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;

    const provider = createAnySearchProvider(defaultConfig, {
      runCommand,
      lookup: publicLookup,
    });
    const outcome = await provider.search({
      query: "q",
      maxResults: 1,
      timeoutMs: 10_000,
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
    expect(outcome.requestId).toBe("rid-success");
    expect(outcome.results).toHaveLength(1);
  });

  it("maps HTTP 401 to a clear auth error with request_id", async () => {
    const runCommand = (async () => ({
      command: "curl",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: curlStdout(
        JSON.stringify({
          code: -1,
          message: "unauthorized",
          request_id: "rid-401",
        }),
        401,
      ),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;

    const provider = createAnySearchProvider(defaultConfig, {
      runCommand,
      lookup: publicLookup,
    });
    await expect(
      provider.search({
        query: "q",
        maxResults: 1,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/HTTP 401.*invalid or revoked.*request_id: rid-401/);
  });

  it("attaches Bearer auth and vertical fields when configured", async () => {
    const previous = process.env.ANYSEARCH_API_KEY;
    process.env.ANYSEARCH_API_KEY = "as_sk_test";
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
            code: 0,
            data: { results: [] },
          }),
        ),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }) as unknown as typeof RunCommandType;

    try {
      const provider = createAnySearchProvider(
        { ...defaultConfig, zone: "intl" },
        { runCommand, lookup: publicLookup },
      );
      await provider.search({
        query: "q",
        maxResults: 1,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
        tag: "code.doc",
        params: { library: "golang" },
        language: "en",
      });
      expect(calls[0]?.args.join("\n")).toContain(
        "Authorization: Bearer as_sk_test",
      );
      expect(calls[0]?.input).toContain('"tag":"code.doc"');
      expect(calls[0]?.input).toContain('"zone":"intl"');
      expect(calls[0]?.input).toContain('"language":"en"');
    } finally {
      if (previous === undefined) delete process.env.ANYSEARCH_API_KEY;
      else process.env.ANYSEARCH_API_KEY = previous;
    }
  });

  it("maps HTTP 402 to WebSearchRateLimitedError", async () => {
    const runCommand = (async () => ({
      command: "curl",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: curlStdout(
        JSON.stringify({
          code: -1,
          message: "quota",
          request_id: "rid-1",
        }),
        402,
      ),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })) as unknown as typeof RunCommandType;

    const provider = createAnySearchProvider(defaultConfig, {
      runCommand,
      lookup: publicLookup,
    });
    await expect(
      provider.search({
        query: "q",
        maxResults: 1,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WebSearchRateLimitedError);
  });
});
