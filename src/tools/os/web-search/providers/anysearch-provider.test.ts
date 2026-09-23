import { describe, expect, it } from "vitest";

import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import {
  createAnySearchProvider,
  parseAnySearchJson,
} from "./anysearch-provider.js";

const MARKER = "__ATOMIC_WEB_SEARCH_META__";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function curlStdout(body: string, status = 200): string {
  return `${body}\n${MARKER}${status}|application/json||${body.length}`;
}

describe("parseAnySearchJson", () => {
  it("normalises AnySearch REST results", () => {
    const body = JSON.stringify({
      code: 0,
      message: "success",
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

  it("throws on a non-zero business code", () => {
    expect(() =>
      parseAnySearchJson(
        JSON.stringify({ code: -1, message: "Query is required." }),
        5,
      ),
    ).toThrow(/Query is required/);
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
      const provider = createAnySearchProvider(
        {
          endpoint: "https://api.anysearch.com/v1/search",
          apiKeyEnv: "ANYSEARCH_API_KEY",
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
      expect(calls[0]?.args).toContain("https://api.anysearch.com/v1/search");
      expect(calls[0]?.args.join("\n")).toContain(
        "X-Anysearch-Client: atomic-agent/web-search",
      );
      expect(calls[0]?.args.join("\n")).not.toContain("Authorization:");
      expect(calls[0]?.input).toContain('"query":"atomic agent"');
      expect(calls[0]?.input).toContain('"max_results":3');
    } finally {
      if (previous === undefined) delete process.env.ANYSEARCH_API_KEY;
      else process.env.ANYSEARCH_API_KEY = previous;
    }
  });

  it("attaches Bearer auth when ANYSEARCH_API_KEY is set", async () => {
    const previous = process.env.ANYSEARCH_API_KEY;
    process.env.ANYSEARCH_API_KEY = "as_sk_test";
    const calls: Array<{ args: string[] }> = [];
    const runCommand = (async (_cmd: string, args: string[]) => {
      calls.push({ args });
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
        {
          endpoint: "https://api.anysearch.com/v1/search",
          apiKeyEnv: "ANYSEARCH_API_KEY",
        },
        { runCommand, lookup: publicLookup },
      );
      await provider.search({
        query: "q",
        maxResults: 1,
        timeoutMs: 10_000,
        cwd: "/tmp",
        signal: new AbortController().signal,
      });
      expect(calls[0]?.args.join("\n")).toContain(
        "Authorization: Bearer as_sk_test",
      );
    } finally {
      if (previous === undefined) delete process.env.ANYSEARCH_API_KEY;
      else process.env.ANYSEARCH_API_KEY = previous;
    }
  });
});
