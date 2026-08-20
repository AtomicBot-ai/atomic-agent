import { describe, expect, it } from "vitest";

import type {
  CommandResult,
  runCommand as RunCommandType,
} from "../../sandbox/command-runner.js";
import { executeGuardedHttpRequest } from "./http-request-fetch.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/** Curl stdout envelope, optionally carrying a Retry-After header value. */
function stubStdout(status: number, retryAfter = ""): string {
  return `body\n__ATOMIC_CURL_META__${status}|text/plain|4|0.01||${retryAfter}`;
}

function makeResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "curl",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
    ...overrides,
  };
}

/** Replays the given results in order, one per curl invocation. */
function scriptedRunCommand(
  results: CommandResult[],
  calls: string[][],
): typeof RunCommandType {
  return (async (_command: string, args: string[]) => {
    const result = results[calls.length] ?? results.at(-1)!;
    calls.push(args);
    return result;
  }) as unknown as typeof RunCommandType;
}

function run(
  input: {
    method?: "GET" | "POST";
    results: CommandResult[];
    calls: string[][];
    slept: number[];
    maxRetries?: number;
  },
) {
  return executeGuardedHttpRequest(
    "https://api.example/v1",
    {
      method: input.method ?? "GET",
      headers: {},
      body: input.method === "POST" ? "{}" : undefined,
      timeoutMs: 1000,
      followRedirects: false,
    },
    {
      runCommand: scriptedRunCommand(input.results, input.calls),
      lookup: publicLookup,
      cwd: "/tmp",
      signal: new AbortController().signal,
      maxResponseBytes: 100_000,
      ...(input.maxRetries !== undefined
        ? {
            retry: {
              maxRetries: input.maxRetries,
              retryBaseDelayMs: 500,
              retryMaxDelayMs: 5_000,
            },
          }
        : {}),
      sleep: async (ms: number) => {
        input.slept.push(ms);
      },
    },
  );
}

describe("os.http.request retries", () => {
  it("retries a 429 GET and returns the eventual success", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      results: [
        makeResult({ stdout: stubStdout(429) }),
        makeResult({ stdout: stubStdout(200) }),
      ],
      calls,
      slept,
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([500]);
  });

  it("retries 502/503/504 as well", async () => {
    for (const status of [502, 503, 504]) {
      const calls: string[][] = [];
      const slept: number[] = [];
      const response = await run({
        results: [
          makeResult({ stdout: stubStdout(status) }),
          makeResult({ stdout: stubStdout(200) }),
        ],
        calls,
        slept,
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
    }
  });

  it("honours Retry-After over its own backoff schedule", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    await run({
      results: [
        makeResult({ stdout: stubStdout(429, "2") }),
        makeResult({ stdout: stubStdout(200) }),
      ],
      calls,
      slept,
    });

    expect(slept).toEqual([2000]);
  });

  it("clamps a hostile Retry-After to the max delay", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    await run({
      results: [
        makeResult({ stdout: stubStdout(429, "3600") }),
        makeResult({ stdout: stubStdout(200) }),
      ],
      calls,
      slept,
    });

    expect(slept).toEqual([5000]);
  });

  it("gives up after maxRetries and returns the last response", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      results: [makeResult({ stdout: stubStdout(503) })],
      calls,
      slept,
    });

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(slept).toEqual([500, 1000]);
  });

  it("does not retry a stable 4xx", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      results: [makeResult({ stdout: stubStdout(404) })],
      calls,
      slept,
    });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("can be disabled with maxRetries: 0", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      results: [makeResult({ stdout: stubStdout(429) })],
      calls,
      slept,
      maxRetries: 0,
    });

    expect(response.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("retries a curl timeout on GET", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      results: [
        makeResult({ exitCode: 28, stderr: "timed out", timedOut: true }),
        makeResult({ stdout: stubStdout(200) }),
      ],
      calls,
      slept,
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a non-timeout curl failure", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    await expect(
      run({
        results: [makeResult({ exitCode: 6, stderr: "could not resolve host" })],
        calls,
        slept,
      }),
    ).rejects.toThrow(/could not resolve host/);

    expect(calls).toHaveLength(1);
  });
});

describe("os.http.request retry safety for non-idempotent methods", () => {
  it("does NOT replay a POST on a bare 503 (no Retry-After)", async () => {
    // The origin may already have processed the request; replaying it blindly
    // would risk a double submit.
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      method: "POST",
      results: [makeResult({ stdout: stubStdout(503) })],
      calls,
      slept,
    });

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("does NOT replay a POST on a curl timeout", async () => {
    const calls: string[][] = [];
    const slept: number[] = [];
    await expect(
      run({
        method: "POST",
        results: [makeResult({ exitCode: 28, stderr: "timed out", timedOut: true })],
        calls,
        slept,
      }),
    ).rejects.toThrow(/timed out/);

    expect(calls).toHaveLength(1);
  });

  it("DOES replay a POST when the server invites it with Retry-After", async () => {
    // 429 + Retry-After is an explicit "I did not process this, come back".
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      method: "POST",
      results: [
        makeResult({ stdout: stubStdout(429, "1") }),
        makeResult({ stdout: stubStdout(200) }),
      ],
      calls,
      slept,
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it("does NOT replay a POST on 502 even with Retry-After", async () => {
    // 502/504 do not carry the same "not processed" guarantee as 429/503.
    const calls: string[][] = [];
    const slept: number[] = [];
    const response = await run({
      method: "POST",
      results: [makeResult({ stdout: stubStdout(502, "1") })],
      calls,
      slept,
    });

    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
  });
});
