import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../../../config/index.js";
import type { runCommand as RunCommandType } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import type { PageRenderer } from "./web-fetch-ladder.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import { buildOsWebCrawlTool } from "./web-crawl.js";
import { buildOsWebFetchTool } from "./web-fetch.js";

/**
 * ATO-2703: a channel guest's `os.web.fetch` / `os.web.crawl` never use
 * the agent's browser. The browser resolves the host on its own (no
 * `--resolve` pin, so a rebinding host can point it at 127.0.0.1) and runs
 * the page's scripts, which can call the owner's local services; only the
 * URL it lands on is checked afterwards. curl stays pinned and checked on
 * every hop, so guests keep that path only.
 */
const MARKER = "__ATOMIC_WEBFETCH_META__";
const CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title>
</head><body><div id="cf-wrapper">Enable JavaScript and cookies to continue
</div></body></html>`;
const SHELL = `<!doctype html><html><head><title>App</title><script src="/app.js"></script></head>` +
  `<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;
const LEAK = `<!doctype html><html><head><title>Doc</title></head><body><article><h1>Owner data</h1>
<p>Text the page's script fetched from http://127.0.0.1:8080 on the owner's machine and wrote into the page, long enough to be the article body.</p>
</article></body></html>`;

function runCommand(routes: Record<string, { status: number; body: string; contentType?: string }>): typeof RunCommandType {
  return (async (_cmd: string, args: string[]) => {
    const url = args[args.length - 1] ?? "";
    const res = routes[url] ?? { status: 404, body: "not found", contentType: "text/plain" };
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: `${res.body}\n${MARKER}${res.status}|${res.contentType ?? "text/html"}||${res.body.length}|`,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

const lookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const ctx = (guest: boolean): ToolContext => ({
  workingDir: "/tmp",
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});
const renderer = (calls: string[]): PageRenderer => async ({ url }) => {
  calls.push(url);
  return { finalUrl: url, title: "Doc", html: LEAK };
};

describe("os.web.fetch for a guest (ATO-2703)", () => {
  const tool = (calls: string[]) =>
    buildOsWebFetchTool({
      runCommand: runCommand({ "https://evil.example/a": { status: 403, body: CHALLENGE } }),
      lookup,
      config: USER_CONFIG_DEFAULTS as never,
      sleep: async () => undefined,
      env: {},
      renderPage: renderer(calls),
    });

  it("does not open a walled page in the browser for a guest", async () => {
    const calls: string[] = [];
    const result = await tool(calls).run({ url: "https://evil.example/a" }, ctx(true));
    expect(calls).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.summary).not.toContain("owner's machine");
  });

  it("still uses the browser for the owner", async () => {
    const calls: string[] = [];
    const result = await tool(calls).run({ url: "https://evil.example/a" }, ctx(false));
    expect(calls).toEqual(["https://evil.example/a"]);
    expect(result.details.readVia).toBe("browser");
  });
});

describe("os.web.crawl for a guest (ATO-2703)", () => {
  const O = "https://app.example";
  const tool = (calls: string[]) => {
    // A clock that the fake sleep moves, so pacing never waits for real.
    let t = 5_000_000;
    return buildOsWebCrawlTool({
      renderPage: renderer(calls),
      runCommand: runCommand({
        [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" },
        [`${O}/`]: { status: 200, body: SHELL },
      }),
      lookup,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
      config: { web: USER_CONFIG_DEFAULTS.web },
    });
  };

  it("does not render a JavaScript page in the browser for a guest", async () => {
    const calls: string[] = [];
    const result = await tool(calls).run({ url: `${O}/`, useSitemap: false }, ctx(true));
    expect(calls).toEqual([]);
    expect(result.summary).not.toContain("owner's machine");
  });

  it("still renders it for the owner", async () => {
    const calls: string[] = [];
    await tool(calls).run({ url: `${O}/`, useSitemap: false }, ctx(false));
    expect(calls).toEqual([`${O}/`]);
  });
});
