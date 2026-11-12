import { describe, it, expect } from "vitest";
import type { runCommand as RunCommandType } from "../../../sandbox/command-runner.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import { describeReadVia, readPastWall, type PageRenderer } from "./web-fetch-ladder.js";
import type { ReaderSettings } from "./web-fetch-readers.js";

const SEARCH_MARKER = "__ATOMIC_WEB_SEARCH_META__";
const SEARCH_HEADERS = "__ATOMIC_WEB_SEARCH_HEADERS__";

const WALL = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div id="cf-wrapper">Enable JavaScript and cookies to continue</div></body></html>`;
const PAGE = `<!doctype html><html><head><title>Real</title></head><body>
<article><p>The real article text.</p></article></body></html>`;

const OFF: ReaderSettings = {
  jinaReader: false,
  jinaApiKeyEnv: "JINA_API_KEY",
  firecrawlApiKeyEnv: "FIRECRAWL_API_KEY",
};

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/** Answers every curl call through the search transport's meta format. */
function readerCurl(
  respond: (url: string, args: string[]) => { status: number; body: string },
): typeof RunCommandType & { urls: string[]; argv: string[][] } {
  const urls: string[] = [];
  const argv: string[][] = [];
  const run = (async (_command: string, args: string[]) => {
    const url = args[args.length - 1] ?? "";
    urls.push(url);
    argv.push(args);
    const res = respond(url, args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: `${res.body}\n${SEARCH_MARKER}${res.status}|application/json||${res.body.length}|${SEARCH_HEADERS}`,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType & { urls: string[]; argv: string[][] };
  run.urls = urls;
  run.argv = argv;
  return run;
}

function base(overrides: Partial<Parameters<typeof readPastWall>[0]> = {}) {
  return {
    url: "https://walled.example/post",
    timeoutMs: 5_000,
    cwd: "/tmp",
    signal: new AbortController().signal,
    renderWithBrowser: true,
    readers: OFF,
    lookup: publicLookup,
    env: {},
    ...overrides,
  };
}

describe("readPastWall (ATO-968)", () => {
  it("returns the rendered page from the agent's browser", async () => {
    const seen: string[] = [];
    const renderPage: PageRenderer = async ({ url, isStillWalled }) => {
      seen.push(url);
      expect(isStillWalled?.(WALL)).toBe(true);
      expect(isStillWalled?.(PAGE)).toBe(false);
      return { finalUrl: "https://walled.example/post", title: "Real", html: PAGE };
    };
    const out = await readPastWall(base({ renderPage }));
    expect(out.page).toMatchObject({ via: "browser", contentType: "text/html", body: PAGE, title: "Real" });
    expect(seen).toEqual(["https://walled.example/post"]);
  });

  it("does not render when renderWithBrowser is off", async () => {
    let calls = 0;
    const renderPage: PageRenderer = async () => {
      calls++;
      return { finalUrl: "https://walled.example/post", title: "", html: PAGE };
    };
    const out = await readPastWall(base({ renderPage, renderWithBrowser: false }));
    expect(calls).toBe(0);
    expect(out.page).toBeNull();
    expect(out.attempts).toEqual([]);
  });

  it("refuses a rendered page that landed on a private address", async () => {
    const lookup: HostLookup = async (host) =>
      host === "internal.example"
        ? [{ address: "10.0.0.5", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];
    const renderPage: PageRenderer = async () => ({
      finalUrl: "http://internal.example/admin",
      title: "",
      html: PAGE,
    });
    const out = await readPastWall(base({ renderPage, lookup }));
    expect(out.page).toBeNull();
    expect(out.attempts[0]).toMatch(/^browser: /);
  });

  it("sends nothing to a reader unless the user enabled one", async () => {
    const run = readerCurl(() => ({ status: 200, body: "{}" }));
    const out = await readPastWall(base({ runCommand: run }));
    expect(out.page).toBeNull();
    expect(run.urls).toEqual([]);
  });

  it("falls through a still-walled render to keyless Jina when jinaReader is on", async () => {
    const renderPage: PageRenderer = async () => ({ finalUrl: "https://walled.example/post", title: "", html: WALL });
    const run = readerCurl(() => ({
      status: 200,
      body: JSON.stringify({ code: 200, data: { title: "Jina title", url: "https://walled.example/post", content: "# Real\n\nfrom jina" } }),
    }));
    const out = await readPastWall(base({ renderPage, runCommand: run, readers: { ...OFF, jinaReader: true } }));
    expect(out.attempts).toEqual(["browser: still a challenge page"]);
    expect(out.page).toMatchObject({ via: "jina", contentType: "text/markdown", body: "# Real\n\nfrom jina", title: "Jina title" });
    expect(run.urls).toEqual(["https://r.jina.ai/https://walled.example/post"]);
    // The key header travels in a header file, never on the command line.
    expect(run.argv[0]?.join(" ")).not.toContain("Bearer");
  });

  it("uses Firecrawl after a failing Jina when its key is set", async () => {
    const run = readerCurl((url) =>
      url.startsWith("https://r.jina.ai/")
        ? { status: 429, body: "{}" }
        : { status: 200, body: JSON.stringify({ success: true, data: { markdown: "from firecrawl", metadata: { title: ["FC"], sourceURL: "https://walled.example/post" } } }) },
    );
    const out = await readPastWall(base({
      runCommand: run,
      env: { JINA_API_KEY: "jina-test-key", FIRECRAWL_API_KEY: "fc-test-key" },
    }));
    expect(out.attempts).toEqual(["jina: Jina Reader answered HTTP 429"]);
    expect(out.page).toMatchObject({ via: "firecrawl", body: "from firecrawl", title: "FC" });
    expect(run.urls).toEqual([
      "https://r.jina.ai/https://walled.example/post",
      "https://api.firecrawl.dev/v2/scrape",
    ]);
    expect(run.argv[1]).toContain("POST");
  });

  it("names the step in the lead line", () => {
    expect(describeReadVia("browser")).toContain("agent's own browser");
    expect(describeReadVia("jina")).toContain("Jina Reader");
    expect(describeReadVia("firecrawl")).toContain("Firecrawl");
  });
});
