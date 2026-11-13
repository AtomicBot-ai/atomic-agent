import { describe, expect, it } from "vitest";
import type { runCommand as RunCommandType } from "../../../sandbox/command-runner.js";
import { USER_CONFIG_DEFAULTS, type WebCrawlConfig } from "../../../config/index.js";
import type { ToolContext } from "../../tool-registry.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import { buildOsWebCrawlTool } from "./web-crawl.js";

const MARKER = "__ATOMIC_WEBFETCH_META__";

interface FakeResponse {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Absolute redirect target (curl's %{redirect_url}). */
  location?: string;
}

function html(title: string, links: string[]): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>
<p>Readable text about ${title} that is long enough to count as the page body for extraction.</p>
${links.map((l) => `<a href="${l}">${l}</a>`).join("\n")}</main></body></html>`;
}

/** A fake site: curl's stdout per URL, plus a record of every request and wait. */
function fakeSite(
  routes: Record<string, FakeResponse>,
  respond: (url: string) => FakeResponse = (url) =>
    routes[url] ?? { status: 404, body: "not found", contentType: "text/plain" },
) {
  const requests: string[] = [];
  const lookups: string[] = [];
  const waits: number[] = [];
  let t = 5_000_000;
  const runCommand = (async (_cmd: string, args: string[]) => {
    const url = args[args.length - 1] ?? "";
    requests.push(url);
    const res = respond(url);
    const headerJson = res.headers
      ? JSON.stringify(Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, [v]])))
      : "";
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: `${res.body}\n${MARKER}${res.status}|${res.contentType ?? "text/html"}|${res.location ?? ""}|${res.body.length}|${headerJson}`,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
  const lookup: HostLookup = async (host) => {
    lookups.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const sleep = async (ms: number) => {
    waits.push(ms);
    t += ms;
  };
  return { runCommand, lookup, sleep, now: () => t, requests, lookups, waits };
}

function tool(site: ReturnType<typeof fakeSite>, crawl: Partial<WebCrawlConfig> = {}) {
  return buildOsWebCrawlTool({
    runCommand: site.runCommand,
    lookup: site.lookup,
    sleep: site.sleep,
    now: site.now,
    config: {
      web: {
        ...USER_CONFIG_DEFAULTS.web,
        fetch: { ...USER_CONFIG_DEFAULTS.web.fetch, maxRetries: 2 },
        crawl: { ...(USER_CONFIG_DEFAULTS.web.crawl as WebCrawlConfig), ...crawl },
      },
    },
  });
}

function ctx(): ToolContext {
  return { workingDir: "/tmp", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
}

const O = "https://docs.example.com";

function docsSite(): Record<string, FakeResponse> {
  return {
    [`${O}/robots.txt`]: {
      status: 200,
      contentType: "text/plain",
      body: `User-agent: *\nDisallow: /private\nSitemap: ${O}/sitemap.xml`,
    },
    [`${O}/sitemap.xml`]: {
      status: 200,
      contentType: "application/xml",
      body: `<urlset><url><loc>${O}/guide/c</loc></url><url><loc>${O}/private/x</loc></url></urlset>`,
    },
    [`${O}/guide/`]: { status: 200, body: html("Guide", ["a", "b", "/private/secret", "https://other.com/z", "a#frag"]) },
    [`${O}/guide/a`]: { status: 200, body: html("Page A", ["/guide/deep"]) },
    [`${O}/guide/b`]: { status: 200, body: html("Page B", []) },
    [`${O}/guide/c`]: { status: 200, body: html("Page C", []) },
    [`${O}/guide/deep`]: { status: 200, body: html("Deep", ["/guide/deeper"]) },
    [`${O}/guide/deeper`]: { status: 200, body: html("Deeper", []) },
  };
}

describe("os.web.crawl", () => {
  it("reads same-site links breadth first, adds sitemap pages, skips robots-blocked and off-site URLs", async () => {
    const site = fakeSite(docsSite());
    const result = await tool(site).run({ url: `${O}/guide/` }, ctx());
    expect(result.status).toBe("ok");
    const pages = (result.details as { pages: { url: string; depth: number }[] }).pages;
    expect(pages.map((p) => p.url)).toEqual([
      `${O}/guide/`,
      `${O}/guide/a`,
      `${O}/guide/b`,
      `${O}/guide/c`,
      `${O}/guide/deep`,
    ]);
    // Depth 2 is the default cap: /guide/deeper (depth 3) is never fetched.
    expect(site.requests).not.toContain(`${O}/guide/deeper`);
    expect(site.requests).not.toContain(`${O}/private/secret`);
    expect(site.requests).not.toContain(`${O}/private/x`);
    expect(site.requests.some((u) => u.startsWith("https://other.com"))).toBe(false);
    expect((result.details as { blockedByRobots: string[] }).blockedByRobots).toEqual([
      `${O}/private/secret`,
      `${O}/private/x`,
    ]);
    expect(result.summary).toContain(`${O}/guide/a`);
    expect(result.summary).toContain("Readable text about Page A");
    expect(result.summary).toContain("robots.txt: file");
  });

  it("goes through the SSRF guard for every request and keeps one second between them", async () => {
    const site = fakeSite(docsSite());
    await tool(site).run({ url: `${O}/guide/` }, ctx());
    expect(site.lookups.length).toBeGreaterThanOrEqual(site.requests.length);
    // robots.txt, sitemap, 5 pages: every request after the first waited its turn.
    expect(site.requests.length).toBe(7);
    expect(site.waits.filter((w) => w >= 1_000).length).toBe(site.requests.length - 1);
  });

  it("refuses a start page robots.txt disallows and names the opt-out", async () => {
    const site = fakeSite(docsSite());
    const result = await tool(site).run({ url: `${O}/private/area` }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("robotsExemptHosts");
    expect(site.requests).toEqual([`${O}/robots.txt`]);
  });

  it("ignores robots.txt for an exempt host but still paces it", async () => {
    const site = fakeSite(docsSite());
    const result = await tool(site, { robotsExemptHosts: ["docs.example.com"] }).run(
      { url: `${O}/guide/`, maxDepth: 1, useSitemap: false },
      ctx(),
    );
    expect(site.requests).not.toContain(`${O}/robots.txt`);
    expect(site.requests).toContain(`${O}/private/secret`);
    expect(result.details?.robots).toBe("exempt");
    expect(site.waits.every((w) => w >= 1_000)).toBe(true);
  });

  it("blocks a private address before any request", async () => {
    const site = fakeSite({});
    const crawl = buildOsWebCrawlTool({
      runCommand: site.runCommand,
      lookup: async () => [{ address: "10.0.0.7", family: 4 }],
      sleep: site.sleep,
      now: site.now,
    });
    const result = await crawl.run({ url: "https://intranet.example.com/" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details?.blocked).toBe(true);
    expect(site.requests).toEqual([]);
  });

  it("stops at maxPages and reports what was left", async () => {
    const site = fakeSite(docsSite());
    const result = await tool(site).run({ url: `${O}/guide/`, maxPages: 2 }, ctx());
    const details = result.details as { pages: unknown[]; stoppedBecause: string; leftUnread: number };
    expect(details.pages).toHaveLength(2);
    expect(details.stoppedBecause).toBe("page-limit");
    expect(details.leftUnread).toBeGreaterThan(0);
  });

  it("caps maxPages and maxDepth at the config limits", async () => {
    const site = fakeSite(docsSite());
    const result = await tool(site, { maxPages: 3, maxDepth: 1 }).run(
      { url: `${O}/guide/`, maxPages: 500, maxDepth: 9 },
      ctx(),
    );
    const pages = (result.details as { pages: { depth: number }[] }).pages;
    expect(pages).toHaveLength(3);
    expect(Math.max(...pages.map((p) => p.depth))).toBeLessThanOrEqual(1);
  });

  it("stops after three pages in a row answer 429 and honours Retry-After", async () => {
    const slow: FakeResponse = { status: 429, body: "slow down", headers: { "retry-after": "4" } };
    const site = fakeSite({
      [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" },
      [`${O}/guide/`]: { status: 200, body: html("Guide", ["a", "b", "c", "d"]) },
      [`${O}/guide/a`]: slow,
      [`${O}/guide/b`]: slow,
      [`${O}/guide/c`]: slow,
      [`${O}/guide/d`]: slow,
    });
    const result = await tool(site).run({ url: `${O}/guide/`, useSitemap: false }, ctx());
    expect((result.details as { stoppedBecause: string }).stoppedBecause).toBe("throttled");
    expect(site.waits.some((w) => w >= 4_000)).toBe(true);
    // One page answering 429 on every retry is one strike, not three.
    expect(site.requests).toContain(`${O}/guide/c`);
    expect(site.requests).not.toContain(`${O}/guide/d`);
  });

  it("gives a second crawl of a throttled site its own strike count", async () => {
    let busy = true;
    const routes: Record<string, FakeResponse> = {
      [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" },
      [`${O}/guide/`]: { status: 200, body: html("Guide", ["a", "b", "c", "d"]) },
      [`${O}/guide/a`]: { status: 200, body: html("Page A", []) },
      [`${O}/guide/b`]: { status: 200, body: html("Page B", []) },
      [`${O}/guide/c`]: { status: 200, body: html("Page C", []) },
      [`${O}/guide/d`]: { status: 200, body: html("Page D", []) },
    };
    const site = fakeSite(routes, (url) => {
      const route = routes[url] ?? { status: 404, body: "not found", contentType: "text/plain" };
      if (busy && url.startsWith(`${O}/guide/`) && url !== `${O}/guide/`) {
        return { status: 429, body: "slow down", headers: { "retry-after": "1" } };
      }
      return route;
    });
    const crawl = tool(site);
    const first = await crawl.run({ url: `${O}/guide/`, useSitemap: false }, ctx());
    expect((first.details as { stoppedBecause: string }).stoppedBecause).toBe("throttled");

    busy = false;
    const before = site.requests.length;
    const second = await crawl.run({ url: `${O}/guide/`, useSitemap: false }, ctx());
    const details = second.details as { pages: unknown[]; stoppedBecause: string };
    expect(details.stoppedBecause).not.toBe("throttled");
    expect(details.pages.length).toBeGreaterThan(1);
    expect(site.requests.slice(before)).toContain(`${O}/guide/a`);
  });

  it("does not follow a same-site redirect into a robots.txt-disallowed path", async () => {
    const site = fakeSite({
      [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /private" },
      [`${O}/`]: { status: 200, body: html("Home", ["/a", "/b"]) },
      [`${O}/a`]: { status: 301, body: "", location: `${O}/private` },
      [`${O}/b`]: { status: 200, body: html("Page B", []) },
      [`${O}/private`]: { status: 200, body: html("Secret", []) },
    });
    const result = await tool(site).run({ url: `${O}/`, useSitemap: false }, ctx());
    const details = result.details as { pages: { url: string }[]; blockedByRobots: string[] };
    expect(site.requests).toContain(`${O}/a`);
    expect(site.requests).not.toContain(`${O}/private`);
    expect(details.pages.map((p) => p.url)).not.toContain(`${O}/private`);
    expect(details.pages.map((p) => p.url)).toContain(`${O}/b`);
    expect(details.blockedByRobots).toContain(`${O}/private`);
  });

  it("reuses cached pages and robots.txt on a second crawl", async () => {
    const site = fakeSite(docsSite());
    const crawl = tool(site);
    await crawl.run({ url: `${O}/guide/`, maxDepth: 1, useSitemap: false }, ctx());
    const first = site.requests.length;
    await crawl.run({ url: `${O}/guide/`, maxDepth: 1, useSitemap: false }, ctx());
    expect(site.requests.length).toBe(first);
  });
});
