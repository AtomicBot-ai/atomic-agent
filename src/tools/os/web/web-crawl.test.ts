import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { runCommand as RunCommandType } from "../../../sandbox/command-runner.js";
import { USER_CONFIG_DEFAULTS, type WebCrawlConfig } from "../../../config/index.js";
import type { ToolContext } from "../../tool-registry.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import type { PageRenderer } from "./web-fetch-ladder.js";
import { buildOsWebCrawlTool } from "./web-crawl.js";

const MARKER = "__ATOMIC_WEBFETCH_META__";

interface FakeResponse {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Absolute redirect target (curl's %{redirect_url}). */
  location?: string;
  /** Raw body bytes (gzip); written to curl's `-o` file when the request asks for one. */
  bytes?: Buffer;
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
  /** Requests made with `-o` (body kept as bytes), and their curl args. */
  const binaryRequests: { url: string; args: string[] }[] = [];
  const lookups: string[] = [];
  const waits: number[] = [];
  let t = 5_000_000;
  const runCommand = (async (_cmd: string, args: string[]) => {
    const url = args[args.length - 1] ?? "";
    requests.push(url);
    const res = respond(url);
    // A binary-body request: curl writes the body to `-o <file>` as sent,
    // and stdout carries only the meta line.
    const outIdx = args.indexOf("-o");
    let stdoutBody = res.body;
    if (outIdx !== -1) {
      binaryRequests.push({ url, args });
      writeFileSync(args[outIdx + 1]!, res.bytes ?? Buffer.from(res.body, "utf8"));
      stdoutBody = "";
    }
    const headerJson = res.headers
      ? JSON.stringify(Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, [v]])))
      : "";
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: `${stdoutBody}\n${MARKER}${res.status}|${res.contentType ?? "text/html"}|${res.location ?? ""}|${res.body.length}|${headerJson}`,
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
  return { runCommand, lookup, sleep, now: () => t, requests, binaryRequests, lookups, waits };
}

function tool(
  site: ReturnType<typeof fakeSite>,
  crawl: Partial<WebCrawlConfig> = {},
  renderPage?: PageRenderer,
) {
  return buildOsWebCrawlTool({
    ...(renderPage ? { renderPage } : {}),
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

  describe("gzipped sitemaps (ATO-970)", () => {
    const xml = (locs: string[]) =>
      `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
    const index = (locs: string[]) =>
      `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
    const base = (sitemap: string): Record<string, FakeResponse> => ({
      [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: `User-agent: *\nAllow: /\nSitemap: ${sitemap}` },
      [`${O}/`]: { status: 200, body: html("Home", []) },
      [`${O}/guide/a`]: { status: 200, body: html("Page A", []) },
      [`${O}/guide/b`]: { status: 200, body: html("Page B", []) },
    });

    it("unzips a .xml.gz sitemap served as application/x-gzip, fetched as raw bytes", async () => {
      const site = fakeSite({
        ...base(`${O}/sitemap.xml.gz`),
        [`${O}/sitemap.xml.gz`]: {
          status: 200,
          contentType: "application/x-gzip",
          body: "",
          bytes: gzipSync(xml([`${O}/guide/a`])),
        },
      });
      const result = await tool(site).run({ url: `${O}/` }, ctx());
      const details = result.details as { pages: { url: string }[]; sitemapPages: number };
      expect(details.pages.map((p) => p.url)).toContain(`${O}/guide/a`);
      expect(details.sitemapPages).toBe(1);
      const sitemapReq = site.binaryRequests.find((r) => r.url === `${O}/sitemap.xml.gz`);
      expect(sitemapReq).toBeDefined();
      // curl must not unpack it: the size cap is ours.
      expect(sitemapReq!.args).not.toContain("--compressed");
      expect(sitemapReq!.args).toContain("Accept-Encoding: gzip");
      expect(sitemapReq!.args).toContain("--max-filesize");
      // Pages are still fetched as text.
      expect(site.binaryRequests.map((r) => r.url)).toEqual([`${O}/sitemap.xml.gz`]);
    });

    it("follows a gzipped sitemap index to a child sent gzipped twice (Content-Encoding on a .gz file)", async () => {
      const site = fakeSite({
        ...base(`${O}/sitemap_index.xml`),
        // Content-Encoding: gzip on the index: curl keeps the bytes as sent.
        [`${O}/sitemap_index.xml`]: {
          status: 200,
          contentType: "application/xml",
          body: "",
          bytes: gzipSync(index([`${O}/pages.xml.gz`])),
        },
        [`${O}/pages.xml.gz`]: {
          status: 200,
          contentType: "application/gzip",
          body: "",
          bytes: gzipSync(gzipSync(xml([`${O}/guide/a`, `${O}/guide/b`]))),
        },
      });
      const result = await tool(site).run({ url: `${O}/` }, ctx());
      const urls = (result.details as { pages: { url: string }[] }).pages.map((p) => p.url);
      expect(urls).toEqual([`${O}/`, `${O}/guide/a`, `${O}/guide/b`]);
    });

    it("skips a sitemap that unzips past the cap and says so, without failing the crawl", async () => {
      const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20));
      expect(bomb.length).toBeLessThan(100_000);
      const site = fakeSite({
        ...base(`${O}/sitemap.xml.gz`),
        [`${O}/sitemap.xml.gz`]: { status: 200, contentType: "application/x-gzip", body: "", bytes: bomb },
      });
      const result = await tool(site).run({ url: `${O}/` }, ctx());
      expect(result.status).toBe("ok");
      const details = result.details as { sitemapPages: number; notes?: string[] };
      expect(details.sitemapPages).toBe(0);
      expect(details.notes?.join("\n")).toContain("gzip bomb");
      expect(result.summary).toContain("gzip bomb");
    });

    it("still reads a plain sitemap.xml", async () => {
      const site = fakeSite({
        ...base(`${O}/sitemap.xml`),
        [`${O}/sitemap.xml`]: { status: 200, contentType: "application/xml", body: xml([`${O}/guide/b`]) },
      });
      const result = await tool(site).run({ url: `${O}/` }, ctx());
      expect((result.details as { pages: { url: string }[] }).pages.map((p) => p.url)).toContain(`${O}/guide/b`);
    });
  });

  describe("start page redirects (ATO-970)", () => {
    const allowAll = { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" };

    it("moves the crawl from example.com to www.example.com after reading the new host's robots.txt", async () => {
      const site = fakeSite({
        "https://example.com/robots.txt": allowAll,
        "https://example.com/": { status: 301, body: "", location: "https://www.example.com/" },
        "https://www.example.com/robots.txt": {
          status: 200,
          contentType: "text/plain",
          body: "User-agent: *\nDisallow: /private",
        },
        "https://www.example.com/": { status: 200, body: html("Home", ["/a", "/private/x"]) },
        "https://www.example.com/a": { status: 200, body: html("Page A", []) },
      });
      const result = await tool(site).run({ url: "https://example.com/", useSitemap: false }, ctx());
      expect(result.status).toBe("ok");
      const details = result.details as { pages: { url: string }[]; blockedByRobots: string[]; notes?: string[] };
      expect(details.pages.map((p) => p.url)).toEqual(["https://www.example.com/", "https://www.example.com/a"]);
      // The new host's robots.txt is read before its first page, and applies.
      expect(site.requests.slice(0, 4)).toEqual([
        "https://example.com/robots.txt",
        "https://example.com/",
        "https://www.example.com/robots.txt",
        "https://www.example.com/",
      ]);
      expect(details.blockedByRobots).toContain("https://www.example.com/private/x");
      expect(details.notes?.join("\n")).toContain("crawled www.example.com instead");
    });

    it("follows http to https on the same host", async () => {
      const site = fakeSite({
        "http://example.com/robots.txt": allowAll,
        "http://example.com/": { status: 301, body: "", location: "https://example.com/" },
        "https://example.com/robots.txt": allowAll,
        "https://example.com/": { status: 200, body: html("Home", []) },
      });
      const result = await tool(site).run({ url: "http://example.com/", useSitemap: false }, ctx());
      expect((result.details as { pages: { url: string }[] }).pages.map((p) => p.url)).toEqual(["https://example.com/"]);
    });

    it("stops, without requesting it, when the start page moves to another site", async () => {
      const site = fakeSite({
        "https://example.com/robots.txt": allowAll,
        "https://example.com/": { status: 302, body: "", location: "https://other.org/landing" },
        "https://other.org/landing": { status: 200, body: html("Other", []) },
      });
      const result = await tool(site).run({ url: "https://example.com/", useSitemap: false }, ctx());
      expect(result.status).toBe("error");
      const details = result.details as { stoppedBecause: string; pages: unknown[] };
      expect(details.stoppedBecause).toBe("start-moved");
      expect(details.pages).toHaveLength(0);
      expect(site.requests.some((u) => u.includes("other.org"))).toBe(false);
      expect(result.summary).toContain("other.org, which is another site");
      expect(result.summary).toContain("crawl https://other.org/landing directly");
    });

    it("does not treat two sites on a shared host (github.io) as one", async () => {
      const site = fakeSite({
        "https://alice.github.io/robots.txt": allowAll,
        "https://alice.github.io/": { status: 301, body: "", location: "https://bob.github.io/" },
      });
      const result = await tool(site).run({ url: "https://alice.github.io/", useSitemap: false }, ctx());
      expect((result.details as { stoppedBecause: string }).stoppedBecause).toBe("start-moved");
      expect(site.requests.some((u) => u.includes("bob.github.io"))).toBe(false);
    });

    it("never requests an off-site redirect target of a deeper page", async () => {
      const site = fakeSite({
        [`${O}/robots.txt`]: allowAll,
        [`${O}/`]: { status: 200, body: html("Home", ["/out", "/b"]) },
        [`${O}/out`]: { status: 302, body: "", location: "https://other.org/x" },
        [`${O}/b`]: { status: 200, body: html("Page B", []) },
      });
      const result = await tool(site).run({ url: `${O}/`, useSitemap: false }, ctx());
      const details = result.details as { pages: { url: string }[]; errors: { url: string; message: string }[] };
      expect(details.pages.map((p) => p.url)).toEqual([`${O}/`, `${O}/b`]);
      expect(site.requests.some((u) => u.includes("other.org"))).toBe(false);
      expect(details.errors[0]?.message).toContain("redirected off the site");
    });
  });

  describe("pages built by JavaScript (ATO-970)", () => {
    const shell = (title: string) =>
      `<!doctype html><html><head><title>${title}</title><script src="/app.js"></script></head>` +
      `<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;
    const routes = (): Record<string, FakeResponse> => ({
      [`${O}/robots.txt`]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /" },
      [`${O}/`]: { status: 200, body: shell("App") },
      [`${O}/docs`]: { status: 200, body: html("Docs", []) },
    });

    it("without a browser, returns the page and says it needs browser.navigate", async () => {
      const site = fakeSite(routes());
      const result = await tool(site).run({ url: `${O}/`, useSitemap: false }, ctx());
      const details = result.details as { needsBrowser?: string[]; retryWith?: string };
      expect(details.needsBrowser).toEqual([`${O}/`]);
      expect(details.retryWith).toBe("browser.navigate");
      expect(result.summary).toContain("built by JavaScript");
      expect(result.summary).toContain("browser.navigate");
    });

    it("renders it in the agent's browser, paced, and follows the links it shows", async () => {
      const site = fakeSite(routes());
      const rendered: string[] = [];
      const renderPage: PageRenderer = async ({ url }) => {
        rendered.push(url);
        return { finalUrl: url, title: "App", html: html("App rendered", ["/docs"]) };
      };
      const result = await tool(site, {}, renderPage).run({ url: `${O}/`, useSitemap: false }, ctx());
      const details = result.details as { pages: { url: string; via?: string }[]; needsBrowser?: string[] };
      expect(rendered).toEqual([`${O}/`]);
      expect(details.pages[0]).toMatchObject({ url: `${O}/`, via: "browser" });
      expect(details.pages.map((p) => p.url)).toContain(`${O}/docs`);
      expect(details.needsBrowser).toBeUndefined();
      expect(result.summary).toContain("Readable text about App rendered");
      // The browser load waited its turn like a curl request.
      expect(site.waits.filter((w) => w >= 1_000).length).toBeGreaterThanOrEqual(site.requests.length);
    });

    it("drops a render that landed on another site and lists the page instead", async () => {
      const site = fakeSite(routes());
      const renderPage: PageRenderer = async () => ({
        finalUrl: "https://login.other.org/",
        title: "Sign in",
        html: html("Sign in", []),
      });
      const result = await tool(site, {}, renderPage).run({ url: `${O}/`, useSitemap: false }, ctx());
      const details = result.details as { pages: { via?: string }[]; needsBrowser?: string[] };
      expect(details.pages[0]?.via).toBeUndefined();
      expect(details.needsBrowser).toEqual([`${O}/`]);
    });

    it("does not render when web.fetch.renderWithBrowser is off", async () => {
      const site = fakeSite(routes());
      let calls = 0;
      const renderPage: PageRenderer = async ({ url }) => {
        calls++;
        return { finalUrl: url, title: "App", html: html("App", []) };
      };
      const crawl = buildOsWebCrawlTool({
        runCommand: site.runCommand,
        lookup: site.lookup,
        sleep: site.sleep,
        now: site.now,
        renderPage,
        config: {
          web: {
            ...USER_CONFIG_DEFAULTS.web,
            fetch: { ...USER_CONFIG_DEFAULTS.web.fetch, renderWithBrowser: false },
            crawl: USER_CONFIG_DEFAULTS.web.crawl as WebCrawlConfig,
          },
        },
      });
      const result = await crawl.run({ url: `${O}/`, useSitemap: false }, ctx());
      expect(calls).toBe(0);
      expect((result.details as { needsBrowser?: string[] }).needsBrowser).toEqual([`${O}/`]);
    });
  });
});
