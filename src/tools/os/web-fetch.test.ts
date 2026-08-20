import { describe, it, expect, vi } from "vitest";
import { buildOsWebFetchTool, parseCurlMeta } from "./web-fetch.js";
import type { runCommand as RunCommandType } from "../../sandbox/command-runner.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import type { ToolContext } from "../tool-registry.js";

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
}): string {
  return `${opts.body}\n${MARKER}${opts.status}|${opts.contentType}|${opts.redirectUrl ?? ""}|${opts.body.length}`;
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
