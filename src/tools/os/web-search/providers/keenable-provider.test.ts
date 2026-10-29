import { afterEach, describe, expect, it, vi } from "vitest";

import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import {
  createKeenableProvider,
  parseKeenableJson,
} from "./keenable-provider.js";

const MARKER = "__ATOMIC_WEB_SEARCH_META__";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function curlStdout(body: string, status = 200): string {
  return `${body}\n${MARKER}${status}|application/json||${body.length}`;
}

describe("parseKeenableJson", () => {
  it("normalises Keenable results, reading the text from `snippet`", () => {
    const body = JSON.stringify({
      results: [
        {
          title: " Keenable Result ",
          url: "https://example.com/keenable ",
          description: "",
          snippet: "# Heading\n\nFirst line.\nSecond   line.",
          acquired_at: "2026-10-28T03:41:47Z",
        },
      ],
    });

    expect(parseKeenableJson(body, 5)).toEqual([
      {
        title: "Keenable Result",
        url: "https://example.com/keenable",
        snippet: "# Heading First line. Second line.",
      },
    ]);
  });

  it("caps a long snippet at 500 characters", () => {
    const body = JSON.stringify({
      results: [
        { title: "Long", url: "https://example.com/long", snippet: "x".repeat(4000) },
      ],
    });

    expect(parseKeenableJson(body, 5)[0]?.snippet).toHaveLength(500);
  });

  it("drops entries without a string title or url", () => {
    const body = JSON.stringify({
      results: [
        { url: "https://example.com/no-title", snippet: "s" },
        { title: 42, url: "https://example.com/bad-title" },
        { title: "Kept", url: "https://example.com/kept", snippet: 7 },
      ],
    });

    expect(parseKeenableJson(body, 5)).toEqual([
      { title: "Kept", url: "https://example.com/kept", snippet: "" },
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

    expect(parseKeenableJson(body, 2)).toHaveLength(2);
  });

  it("returns empty for a body without a results array", () => {
    expect(parseKeenableJson(JSON.stringify({ detail: "error" }), 5)).toEqual([]);
  });
});

describe("createKeenableProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function searchWith(key: string) {
    vi.stubEnv("KEENABLE_API_KEY", key);
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
            results: [{ title: "A", url: "https://example.com", snippet: "S" }],
          }),
        ),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }) as unknown as typeof RunCommandType;
    const provider = createKeenableProvider(
      { apiKeyEnv: "KEENABLE_API_KEY" },
      { runCommand, lookup: publicLookup },
    );
    const results = await provider.search({
      query: "atomic agent",
      maxResults: 3,
      timeoutMs: 10_000,
      cwd: "/tmp",
      signal: new AbortController().signal,
    });
    return { results, calls };
  }

  it("runs keyless on the public endpoint, naming the app", async () => {
    const { results, calls } = await searchWith("");

    expect(results).toEqual([
      { title: "A", url: "https://example.com", snippet: "S" },
    ]);
    expect(calls[0]?.args).toContain("https://api.keenable.ai/v1/search/public");
    expect(calls[0]?.args.join("\n")).toContain("X-Keenable-Title: atomic-agent");
    expect(calls[0]?.args.join("\n")).not.toContain("X-API-Key");
    expect(calls[0]?.input).toContain('"query":"atomic agent"');
    expect(calls[0]?.input).toContain('"max_results":3');
  });

  it("uses the keyed endpoint when the configured env var is present", async () => {
    const { calls } = await searchWith("test-key");

    expect(calls[0]?.args).toContain("https://api.keenable.ai/v1/search");
    expect(calls[0]?.args.join("\n")).toContain("X-API-Key: test-key");
    expect(calls[0]?.args.join("\n")).toContain("X-Keenable-Title: atomic-agent");
  });
});
