import { describe, expect, it } from "vitest";

import { searchHttp } from "./search-http.js";
import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import type { HostLookup } from "../../web-fetch-ssrf-guard.js";

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/**
 * Builds the curl stdout envelope that `parseCurlMeta` expects: the response
 * body followed by the trailing `__ATOMIC_WEB_SEARCH_META__status|ct|redir|size`
 * block that searchHttp appends via `curl -w`.
 */
function stubCurlStdout(body: string): string {
  return `${body}\n__ATOMIC_WEB_SEARCH_META__200|text/html||${body.length}`;
}

/** Curl envelope for an arbitrary status, with an optional Retry-After header. */
function stubCurlStatus(status: number, retryAfter = ""): string {
  const header = `__ATOMIC_WEB_SEARCH_HEADERS__${retryAfter}`;
  return `body\n__ATOMIC_WEB_SEARCH_META__${status}|text/html||4|${header}`;
}

/** Replays the given stdout envelopes in order, one per curl invocation. */
function scriptedRunCommand(
  stdouts: string[],
  calls: string[][],
): typeof RunCommandType {
  return (async (_command: string, args: string[]) => {
    const stdout = stdouts[calls.length] ?? stdouts.at(-1)!;
    calls.push(args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

function capturingRunCommand(calls: string[][]): typeof RunCommandType {
  return (async (_command: string, args: string[]) => {
    calls.push(args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: stubCurlStdout("<html></html>"),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

describe("searchHttp curl argv", () => {
  it("passes --globoff so bracketed URLs are not read as curl ranges", async () => {
    // Search queries routinely carry `[`/`]`/`{`/`}`. Without --globoff curl
    // reads them as its own range/set syntax and fails with "bad range in URL".
    const calls: string[][] = [];
    const url =
      "https://search.example/search?q=filter:original:.*[Dd]ewey.*" +
      "&range=[202102010000+TO+202104300000]";
    await searchHttp({
      url,
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: capturingRunCommand(calls),
      lookup: publicLookup,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--globoff");
    // The bracketed URL still reaches curl verbatim as the final operand.
    expect(calls[0]![calls[0]!.length - 1]).toContain("[Dd]ewey");
  });
});

describe("searchHttp 429 retry", () => {
  /** Records requested backoff instead of spending real wall-clock. */
  function fakeSleep(slept: number[]) {
    return async (ms: number) => {
      slept.push(ms);
    };
  }

  it("retries the SAME provider on 429 and returns the eventual success", async () => {
    // The regression this guards: one transient 429 used to throw straight out
    // of the provider, permanently downgrading the session to a weaker one.
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand(
        [stubCurlStatus(429), stubCurlStdout("<html>ok</html>")],
        calls,
      ),
      lookup: publicLookup,
      sleep: fakeSleep(slept),
    });

    expect(calls).toHaveLength(2);
    expect(response.status).toBe(200);
    expect(slept).toEqual([500]);
  });

  it("honours the server's Retry-After over its own backoff schedule", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand(
        [stubCurlStatus(429, "3"), stubCurlStdout("<html>ok</html>")],
        calls,
      ),
      lookup: publicLookup,
      sleep: fakeSleep(slept),
      now: () => Date.parse("2026-08-20T12:00:00Z"),
    });

    expect(slept).toEqual([3000]);
  });

  it("gives up after maxRetries and returns the 429 so the chain advances", async () => {
    // Retrying must not mask a real, standing rate limit: the fallback chain
    // is still the backstop once the retries are spent.
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand([stubCurlStatus(429)], calls),
      lookup: publicLookup,
      sleep: fakeSleep(slept),
    });

    expect(response.status).toBe(429);
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(slept).toEqual([500, 1000]);
  });

  it("does not retry a non-429 failure", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand([stubCurlStatus(503)], calls),
      lookup: publicLookup,
      sleep: fakeSleep(slept),
    });

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("can be disabled with maxRetries: 0", async () => {
    const calls: string[][] = [];
    await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand([stubCurlStatus(429)], calls),
      lookup: publicLookup,
      retryPolicy: { maxRetries: 0, baseDelayMs: 500 },
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
  });

  it("tolerates a curl too old for %header{} and falls back to backoff", async () => {
    // curl < 7.83 emits the literal format string; it must not be read as a
    // Retry-After value.
    const calls: string[][] = [];
    const slept: number[] = [];
    await searchHttp({
      url: "https://search.example/q",
      timeoutMs: 1000,
      cwd: "/tmp",
      signal: new AbortController().signal,
      runCommand: scriptedRunCommand(
        [
          "body\n__ATOMIC_WEB_SEARCH_META__429|text/html||4|" +
            "__ATOMIC_WEB_SEARCH_HEADERS__%header{retry-after}",
          stubCurlStdout("<html>ok</html>"),
        ],
        calls,
      ),
      lookup: publicLookup,
      sleep: fakeSleep(slept),
    });

    expect(slept).toEqual([500]);
  });
});
