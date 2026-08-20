import { describe, it, expect, vi } from "vitest";
import { buildOsWebFetchTool, parseCurlMeta } from "./web-fetch.js";
import type { runCommand as RunCommandType } from "../../sandbox/command-runner.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import type { ToolContext } from "../tool-registry.js";
import { USER_CONFIG_DEFAULTS } from "../../config/index.js";

const MARKER = "__ATOMIC_WEBFETCH_META__";

const ARTICLE = `<!doctype html><html><head><title>Doc</title></head><body>
<article><h1>Hello</h1>
<p>A sufficiently long first paragraph of readable prose so Readability keeps
the article body and does not bail out to the basic fallback path here.</p>
<p>A second paragraph that adds more readable content to the article body so
the extractor is confident this is the main content of the page.</p>
</article></body></html>`;

function curlStdout(opts: {
  body: string;
  status: number;
  contentType: string;
  redirectUrl?: string;
  /** Response headers rendered the way curl's `%{header_json}` emits them. */
  headers?: Record<string, string>;
}): string {
  const headerJson =
    opts.headers === undefined
      ? ""
      : JSON.stringify(
          Object.fromEntries(
            Object.entries(opts.headers).map(([k, v]) => [k, [v]]),
          ),
        );
  return `${opts.body}\n${MARKER}${opts.status}|${opts.contentType}|${opts.redirectUrl ?? ""}|${opts.body.length}|${headerJson}`;
}

/** Collects backoff waits instead of sleeping, so retry tests run instantly. */
function fakeSleep(): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

function makeRunCommand(
  responder: (url: string) => { stdout: string; exitCode?: number; stderr?: string },
): typeof RunCommandType {
  return (async (_command: string, args: string[]) => {
    const url = args[args.length - 1] ?? "";
    const res = responder(url);
    return {
      command: "curl",
      args,
      exitCode: res.exitCode ?? 0,
      signal: null,
      stdout: res.stdout,
      stderr: res.stderr ?? "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

function ctx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("parseCurlMeta", () => {
  it("splits body from trailing metadata", () => {
    const parsed = parseCurlMeta(
      `the body\n${MARKER}200|text/html; charset=utf-8|https://x/redir|123`,
    );
    expect(parsed.body).toBe("the body");
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe("text/html; charset=utf-8");
    expect(parsed.redirectUrl).toBe("https://x/redir");
  });

  it("parses Retry-After out of the header_json field", () => {
    const parsed = parseCurlMeta(
      `body\n${MARKER}503|text/html|| 5|{"retry-after":["7"],"server":["x"]}`,
    );
    expect(parsed.status).toBe(503);
    expect(parsed.retryAfterMs).toBe(7_000);
  });

  it("keeps header_json containing pipes out of the fixed fields", () => {
    const parsed = parseCurlMeta(
      `body\n${MARKER}200|text/html||4|{"x-thing":["a|b"],"retry-after":["3"]}`,
    );
    expect(parsed.contentType).toBe("text/html");
    expect(parsed.retryAfterMs).toBe(3_000);
  });

  it("yields no Retry-After when header_json is absent (older curl)", () => {
    const parsed = parseCurlMeta(`body\n${MARKER}503|text/html||4|%{header_json}`);
    expect(parsed.status).toBe(503);
    expect(parsed.retryAfterMs).toBeNull();
  });
});

describe("os.web.fetch tool", () => {
  it("fetches and extracts an article via Readability", async () => {
    const tool = buildOsWebFetchTool({
      runCommand: makeRunCommand(() => ({
        stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
      })),
      lookup: publicLookup,
    });
    const result = await tool.run({ url: "https://example.com/doc" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.extractor).toBe("readability");
    expect(result.details.finalUrl).toBe("https://example.com/doc");
    expect(result.summary).toContain("first paragraph");
  });

  it("follows a redirect and re-validates the next hop", async () => {
    const run = vi.fn(
      makeRunCommand((url) => {
        if (url === "https://example.com/start") {
          return {
            stdout: curlStdout({
              body: "",
              status: 302,
              contentType: "text/html",
              redirectUrl: "https://example.com/final",
            }),
          };
        }
        return {
          stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
        };
      }),
    );
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup });
    const result = await tool.run({ url: "https://example.com/start" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.finalUrl).toBe("https://example.com/final");
    expect(result.details.redirectChain).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns a structured error and never fetches a private address", async () => {
    const run = vi.fn(makeRunCommand(() => ({ stdout: "" })));
    const tool = buildOsWebFetchTool({
      runCommand: run,
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
    });
    const result = await tool.run({ url: "https://intranet.example" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.blocked).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes without fetching", async () => {
    const run = vi.fn(makeRunCommand(() => ({ stdout: "" })));
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup });
    const result = await tool.run({ url: "file:///etc/passwd" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.blocked).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("caps output at maxChars", async () => {
    const big = `<html><body><article><h1>t</h1><p>${"word ".repeat(5000)}</p></article></body></html>`;
    const tool = buildOsWebFetchTool({
      runCommand: makeRunCommand(() => ({
        stdout: curlStdout({ body: big, status: 200, contentType: "text/html" }),
      })),
      lookup: publicLookup,
    });
    const result = await tool.run(
      { url: "https://example.com/big", maxChars: 200 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.truncated).toBe(true);
  });

  it("rejects an empty url", async () => {
    const tool = buildOsWebFetchTool({ lookup: publicLookup });
    await expect(tool.run({ url: "" }, ctx())).rejects.toThrow();
  });

  it("returns status:error for a 404 while keeping details", async () => {
    const tool = buildOsWebFetchTool({
      runCommand: makeRunCommand(() => ({
        stdout: curlStdout({
          body: "<html><body>not found</body></html>",
          status: 404,
          contentType: "text/html",
        }),
      })),
      lookup: publicLookup,
    });
    const result = await tool.run({ url: "https://example.com/missing" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("HTTP 404");
    expect(result.details.status).toBe(404);
    expect(result.details.finalUrl).toBe("https://example.com/missing");
    expect(typeof result.details.extractedText).toBe("string");
  });

  it("returns status:error for a 500", async () => {
    const tool = buildOsWebFetchTool({
      runCommand: makeRunCommand(() => ({
        stdout: curlStdout({
          body: "<html><body>boom</body></html>",
          status: 500,
          contentType: "text/html",
        }),
      })),
      lookup: publicLookup,
    });
    const result = await tool.run({ url: "https://example.com/boom" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("HTTP 500");
    expect(result.details.status).toBe(500);
  });

  it("passes --globoff so bracketed URLs are not read as curl ranges", async () => {
    // Real failure from the field: without --globoff curl rejects the
    // `[... TO ...]` date range with "curl: (3) bad range in URL position 124".
    const url =
      "http://export.arxiv.org/api/query?search_query=all:%22multiwavelength%22" +
      "+AND+submittedDate:[202102010000+TO+202104300000]&start=0&max_results=30";
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({
          body: "<feed></feed>",
          status: 200,
          contentType: "application/atom+xml",
        }),
      })),
    );
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup });
    await tool.run({ url }, ctx());
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0]![1] as string[];
    expect(args).toContain("--globoff");
    // The bracketed URL still reaches curl verbatim as the final operand.
    expect(args[args.length - 1]).toContain("[202102010000");
  });
});

// Issue #181 — 236 timeout failures each burned a fixed 30s of the task
// budget, with no connect timeout and no way to shorten the wait.
describe("os.web.fetch timeouts (#181)", () => {
  function cfg(fetch: Partial<{
    timeoutMs: number;
    connectTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  }>) {
    return {
      web: {
        search: USER_CONFIG_DEFAULTS.web.search,
        fetch: { ...USER_CONFIG_DEFAULTS.web.fetch, ...fetch },
      },
    };
  }

  it("passes --connect-timeout so dead hosts fail fast", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
      })),
    );
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup });
    await tool.run({ url: "https://example.com/doc" }, ctx());
    const args = run.mock.calls[0]![1] as string[];
    // Default connect budget is 10s, well below the 30s overall budget.
    expect(args[args.indexOf("--connect-timeout") + 1]).toBe("10");
  });

  it("uses the configured timeoutMs for --max-time", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
      })),
    );
    const tool = buildOsWebFetchTool({
      runCommand: run,
      lookup: publicLookup,
      config: cfg({ timeoutMs: 8_000, connectTimeoutMs: 3_000 }),
    });
    await tool.run({ url: "https://example.com/doc" }, ctx());
    const args = run.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--max-time") + 1]).toBe("8");
    expect(args[args.indexOf("--connect-timeout") + 1]).toBe("3");
  });

  it("lets a per-call timeoutMs override the configured default", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
      })),
    );
    const tool = buildOsWebFetchTool({
      runCommand: run,
      lookup: publicLookup,
      config: cfg({ timeoutMs: 30_000 }),
    });
    await tool.run({ url: "https://example.com/doc", timeoutMs: 5_000 }, ctx());
    const args = run.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--max-time") + 1]).toBe("5");
  });

  it("never lets the connect budget exceed a smaller per-call timeout", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
      })),
    );
    const tool = buildOsWebFetchTool({
      runCommand: run,
      lookup: publicLookup,
      config: cfg({ timeoutMs: 30_000, connectTimeoutMs: 10_000 }),
    });
    await tool.run({ url: "https://example.com/doc", timeoutMs: 2_000 }, ctx());
    const args = run.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--max-time") + 1]).toBe("2");
    expect(args[args.indexOf("--connect-timeout") + 1]).toBe("2");
  });
});

// Issue #180 — os.web.fetch never retried. 128 of 130 real 503s came from
// web.archive.org, which serves the very same URL seconds later.
describe("os.web.fetch retries (#180)", () => {
  const ARCHIVE_URL = "https://web.archive.org/web/2023/https://example.com";

  it("retries a 503 from web.archive.org and succeeds on the second attempt", async () => {
    let attempts = 0;
    const run = vi.fn(
      makeRunCommand(() => {
        attempts += 1;
        if (attempts === 1) {
          return {
            stdout: curlStdout({
              body: "<html><body>slow down</body></html>",
              status: 503,
              contentType: "text/html",
            }),
          };
        }
        return {
          stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
        };
      }),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: ARCHIVE_URL }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    // First backoff is the base delay.
    expect(waits).toEqual([500]);
  });

  it("returns the error once the retry budget is exhausted", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({
          body: "<html><body>still down</body></html>",
          status: 503,
          contentType: "text/html",
        }),
      })),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: ARCHIVE_URL }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.status).toBe(503);
    // Default maxRetries: 2 → 3 attempts total, exponential 500ms then 1000ms.
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1_000]);
  });

  it("does NOT retry a 404", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({
          body: "<html><body>not found</body></html>",
          status: 404,
          contentType: "text/html",
        }),
      })),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: "https://example.com/missing" }, ctx());
    expect(result.status).toBe("error");
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("retries a curl timeout (exit 28)", async () => {
    let attempts = 0;
    const run = vi.fn(
      makeRunCommand(() => {
        attempts += 1;
        if (attempts === 1) {
          return {
            stdout: "",
            exitCode: 28,
            stderr: "curl: (28) Connection timed out after 30006 milliseconds",
          };
        }
        return {
          stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
        };
      }),
    );
    const { sleep } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: "https://example.com/slow" }, ctx());
    expect(result.status).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-timeout curl failure", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: "",
        exitCode: 6,
        stderr: "curl: (6) Could not resolve host: nope.invalid",
      })),
    );
    const { sleep } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: "https://nope.invalid/x" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Could not resolve host");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("honours a Retry-After header over the computed backoff", async () => {
    let attempts = 0;
    const run = vi.fn(
      makeRunCommand(() => {
        attempts += 1;
        if (attempts === 1) {
          return {
            stdout: curlStdout({
              body: "",
              status: 429,
              contentType: "text/html",
              headers: { "retry-after": "2" },
            }),
          };
        }
        return {
          stdout: curlStdout({ body: ARTICLE, status: 200, contentType: "text/html" }),
        };
      }),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run({ url: "https://example.com/limited" }, ctx());
    expect(result.status).toBe("ok");
    // 2s from the header, not the 500ms base delay.
    expect(waits).toEqual([2_000]);
  });

  it("clamps an oversized Retry-After to retryMaxDelayMs", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({
          body: "",
          status: 503,
          contentType: "text/html",
          headers: { "retry-after": "3600" },
        }),
      })),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    await tool.run({ url: ARCHIVE_URL }, ctx());
    // Never parks the agent for an hour — capped at the 5s default.
    expect(waits).toEqual([5_000, 5_000]);
  });

  it("respects maxRetries: 0 (retrying disabled)", async () => {
    const run = vi.fn(
      makeRunCommand(() => ({
        stdout: curlStdout({ body: "", status: 503, contentType: "text/html" }),
      })),
    );
    const { sleep } = fakeSleep();
    const tool = buildOsWebFetchTool({
      runCommand: run,
      lookup: publicLookup,
      sleep,
      config: {
        web: {
          search: USER_CONFIG_DEFAULTS.web.search,
          fetch: { ...USER_CONFIG_DEFAULTS.web.fetch, maxRetries: 0 },
        },
      },
    });
    const result = await tool.run({ url: ARCHIVE_URL }, ctx());
    expect(result.status).toBe("error");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the abort signal fires", async () => {
    const controller = new AbortController();
    const run = vi.fn(
      makeRunCommand(() => {
        // The task is cancelled while the first attempt is in flight.
        controller.abort();
        return {
          stdout: curlStdout({ body: "", status: 503, contentType: "text/html" }),
        };
      }),
    );
    const { sleep, waits } = fakeSleep();
    const tool = buildOsWebFetchTool({ runCommand: run, lookup: publicLookup, sleep });
    const result = await tool.run(
      { url: ARCHIVE_URL },
      { ...ctx(), signal: controller.signal },
    );
    expect(result.status).toBe("error");
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});
