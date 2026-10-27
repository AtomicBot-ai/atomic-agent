import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../../../config/index.js";
import type { runCommand as RunCommandType } from "../../../../sandbox/command-runner.js";
import type { ToolContext } from "../../../tool-registry.js";
import { buildOsWebSearchTool } from "./web-search-tool.js";

const MARKER = "__ATOMIC_WEB_SEARCH_META__";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function makeConfig(
  overrides: Partial<AtomicAgentConfig["web"]["search"]> = {},
): Pick<AtomicAgentConfig, "web"> {
  return {
    web: {
      search: {
        enabled: true,
        provider: "duckduckgo",
        maxResults: 8,
        timeoutMs: 15_000,
        cacheTtlMinutes: 15,
        persistCache: true,
        fallback: [],
        searxng: { instanceUrl: null },
        exa: {
          endpoint: "https://mcp.exa.ai/mcp",
          apiEndpoint: "https://api.exa.ai/search",
          apiKeyEnv: "EXA_API_KEY",
        },
        brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
        ...overrides,
      },
    },
  };
}

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function curlStdout(body: string, status = 200): string {
  return `${body}\n${MARKER}${status}|text/html||${body.length}`;
}

function makeRunCommand(body: string): typeof RunCommandType {
  return (async () => ({
    command: "curl",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: curlStdout(body),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
  })) as unknown as typeof RunCommandType;
}

const RESULT_HTML = `
  <div class="result">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example Doc</a>
    <a class="result__snippet">A useful result snippet.</a>
  </div>
`;

const BLOCKED_HTML = '<form class="challenge-form">are you a human</form>';

/** A runCommand that returns a different body per target host (last curl arg). */
function makeUrlAwareRunCommand(
  bodyByHost: Record<string, string>,
): typeof RunCommandType {
  return (async (_cmd: string, args: string[]) => {
    const url = args.at(-1) ?? "";
    const host = matchHost(url, Object.keys(bodyByHost));
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: curlStdout(host ? bodyByHost[host]! : ""),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }) as unknown as typeof RunCommandType;
}

function matchHost(url: string, hosts: string[]): string | undefined {
  return hosts.find((host) => url.includes(host));
}

describe("os.web.search", () => {
  it("searches with the default DuckDuckGo provider and returns compact results", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example Doc</a>
        <a class="result__snippet">A useful result snippet.</a>
      </div>
    `;
    const tool = buildOsWebSearchTool({
      config: makeConfig(),
      runCommand: makeRunCommand(html),
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "example docs" }, makeCtx());

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Example Doc");
    expect(result.summary).toContain("URL: https://example.com/doc");
    expect(result.details.provider).toBe("duckduckgo");
  });

  it("returns a structured error when disabled", async () => {
    const run = vi.fn(makeRunCommand(""));
    const tool = buildOsWebSearchTool({
      config: makeConfig({ enabled: false }),
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "example docs" }, makeCtx());

    expect(result.status).toBe("error");
    expect(result.summary).toContain("disabled by config");
    expect(run).not.toHaveBeenCalled();
  });

  it("serves a cache hit on a repeated query without calling the provider again", async () => {
    const run = vi.fn(makeRunCommand(RESULT_HTML));
    const tool = buildOsWebSearchTool({
      config: makeConfig(),
      runCommand: run,
      lookup: publicLookup,
    });

    const first = await tool.run({ query: "same query" }, makeCtx());
    expect(first.status).toBe("ok");
    expect(first.details.fromCache).toBe(false);
    const callsAfterFirst = run.mock.calls.length;

    const second = await tool.run({ query: "same query" }, makeCtx());
    expect(second.status).toBe("ok");
    expect(second.details.fromCache).toBe(true);
    expect(run.mock.calls.length).toBe(callsAfterFirst);
  });

  it("falls back to the next provider when the primary is blocked", async () => {
    const searxngJson = JSON.stringify({
      results: [
        {
          title: "Sx Result",
          url: "https://sx.example/p",
          content: "sx snippet",
        },
      ],
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({
        provider: "duckduckgo",
        fallback: ["searxng"],
        searxng: { instanceUrl: "https://searx.example" },
      }),
      runCommand: makeUrlAwareRunCommand({
        "duckduckgo.com": BLOCKED_HTML,
        "searx.example": searxngJson,
      }),
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "fallback please" }, makeCtx());

    expect(result.status).toBe("ok");
    expect(result.details.provider).toBe("searxng");
    expect(result.summary).toContain("Sx Result");
  });

  it("returns a structured error when the only provider is blocked", async () => {
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "duckduckgo", fallback: [] }),
      runCommand: makeRunCommand(BLOCKED_HTML),
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "blocked everywhere" }, makeCtx());

    expect(result.status).toBe("error");
    expect(result.details.provider).toBe("duckduckgo");
  });
});

describe("os.web.search persistent cache (#256)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "web-search-state-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a second tool instance (fresh process, same stateDir) serves the cached result", async () => {
    const firstRun = vi.fn(makeRunCommand(RESULT_HTML));
    const first = buildOsWebSearchTool({
      config: makeConfig(),
      stateDir,
      runCommand: firstRun,
      lookup: publicLookup,
    });
    const miss = await first.run({ query: "same query" }, makeCtx());
    expect(miss.status).toBe("ok");
    expect(miss.details.fromCache).toBe(false);
    expect(existsSync(join(stateDir, "web-search-cache.json"))).toBe(true);

    // A new builder call is what a new per-task process looks like from
    // the cache's point of view: nothing shared but the stateDir.
    const secondRun = vi.fn(makeRunCommand(RESULT_HTML));
    const second = buildOsWebSearchTool({
      config: makeConfig(),
      stateDir,
      runCommand: secondRun,
      lookup: publicLookup,
    });
    const hit = await second.run({ query: "same query" }, makeCtx());
    expect(hit.status).toBe("ok");
    expect(hit.details.fromCache).toBe(true);
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("web.search.persistCache: false keeps the cache in-memory", async () => {
    const first = buildOsWebSearchTool({
      config: makeConfig({ persistCache: false }),
      stateDir,
      runCommand: makeRunCommand(RESULT_HTML),
      lookup: publicLookup,
    });
    await first.run({ query: "same query" }, makeCtx());
    expect(existsSync(join(stateDir, "web-search-cache.json"))).toBe(false);

    const secondRun = vi.fn(makeRunCommand(RESULT_HTML));
    const second = buildOsWebSearchTool({
      config: makeConfig({ persistCache: false }),
      stateDir,
      runCommand: secondRun,
      lookup: publicLookup,
    });
    const result = await second.run({ query: "same query" }, makeCtx());
    expect(result.details.fromCache).toBe(false);
    expect(secondRun).toHaveBeenCalled();
  });

  it("without a stateDir the cache stays in-memory (embedders and tests)", async () => {
    const first = buildOsWebSearchTool({
      config: makeConfig(),
      runCommand: makeRunCommand(RESULT_HTML),
      lookup: publicLookup,
    });
    await first.run({ query: "same query" }, makeCtx());

    const secondRun = vi.fn(makeRunCommand(RESULT_HTML));
    const second = buildOsWebSearchTool({
      config: makeConfig(),
      runCommand: secondRun,
      lookup: publicLookup,
    });
    const result = await second.run({ query: "same query" }, makeCtx());
    expect(result.details.fromCache).toBe(false);
    expect(secondRun).toHaveBeenCalled();
  });
});

describe("buildOsWebSearchTool missing-key warning", () => {
  it("warns once at construction, not once per search", async () => {
    // Per-search warnings would flood a long autonomous run; the operator
    // needs exactly one line telling them search is degraded (#179).
    const warnings: string[] = [];
    // Fail every curl immediately: this test is about warning cardinality,
    // and a real network round-trip would make it slow and flaky.
    const failingRunCommand = (async () => {
      throw new Error("network disabled in test");
    }) as unknown as typeof RunCommandType;
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "brave", fallback: ["duckduckgo"] }),
      env: {},
      warn: (message) => warnings.push(message),
      runCommand: failingRunCommand,
      lookup: publicLookup,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("BRAVE_SEARCH_API_KEY");

    await tool.run({ query: "a" }, makeCtx()).catch(() => undefined);
    await tool.run({ query: "b" }, makeCtx()).catch(() => undefined);

    expect(warnings).toHaveLength(1);
  });

  it("stays silent when the provider key is set", () => {
    const warnings: string[] = [];
    buildOsWebSearchTool({
      config: makeConfig({ provider: "brave" }),
      env: { BRAVE_SEARCH_API_KEY: "k" },
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("stays silent for the shipped default, exa with no EXA_API_KEY (ATO-120)", () => {
    const warnings: string[] = [];
    buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });
});

/**
 * ATO-120 and ATO-327, end to end through the tool. The Exa provider reads
 * its key from `process.env`, so these stub it there rather than through
 * `env`.
 */
describe("os.web.search with an Exa primary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  interface HostReply {
    body: string;
    status: number;
    /** `Retry-After` header; `"0"` keeps the 429 retries off the clock. */
    retryAfter?: string;
    /** A curl failure instead of an HTTP answer. */
    exitCode?: number;
    stderr?: string;
  }

  /** Per-host reply, recording every URL curl was pointed at. */
  function makeRecordingRunCommand(byHost: Record<string, HostReply>) {
    const urls: string[] = [];
    const run = (async (_cmd: string, args: string[]) => {
      const url = args.at(-1) ?? "";
      urls.push(url);
      const host = matchHost(url, Object.keys(byHost));
      const reply: HostReply = host ? byHost[host]! : { body: "", status: 200 };
      return {
        command: "curl",
        args,
        exitCode: reply.exitCode ?? 0,
        signal: null,
        stdout:
          reply.exitCode === undefined
            ? `${curlStdout(reply.body, reply.status)}|__ATOMIC_WEB_SEARCH_HEADERS__${reply.retryAfter ?? ""}`
            : "",
        stderr: reply.stderr ?? "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }) as unknown as typeof RunCommandType;
    return { run, urls };
  }

  const KEY_REQUIRED_RATE_LIMITED = {
    provider: "exa",
    reason: "rate_limited",
    getKeyUrl: "https://dashboard.exa.ai/api-keys",
    envVar: "EXA_API_KEY",
  };

  const FREE_LIMIT: HostReply = {
    body: "Rate limit exceeded. Create API key at https://dashboard.exa.ai/api-keys",
    status: 429,
    retryAfter: "0",
  };

  it("asks keyless Exa first, then answers ok from DuckDuckGo", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run, urls } = makeRecordingRunCommand({
      "exa.ai": { body: "Forbidden", status: 403 },
      "duckduckgo.com": { body: RESULT_HTML, status: 200 },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "keyless exa" }, makeCtx());

    expect(result.status).toBe("ok");
    expect(result.details.provider).toBe("duckduckgo");
    expect(result.details.degraded).toEqual([
      "exa failed: Exa returned HTTP 403",
    ]);
    expect(result.details.keyRequired).toBeUndefined();
    expect(result.summary).toContain("Example Doc");
    expect(urls[0]).toContain("mcp.exa.ai");
    expect(urls.at(-1)).toContain("duckduckgo.com");
  });

  it("puts keyRequired in details when keyless Exa reaches its free limit", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": { body: RESULT_HTML, status: 200 },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "free limit" }, makeCtx());

    expect(result.status).toBe("ok");
    expect(result.details.provider).toBe("duckduckgo");
    expect(result.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(result.summary).toContain(
      "[search] exa free limit reached (HTTP 429, no EXA_API_KEY)",
    );
  });

  it("returns one error naming every provider and the key link when all fail (ATO-325)", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": {
        body: "",
        status: 0,
        exitCode: 28,
        stderr: "curl: (28) Connection timed out after 15005 milliseconds",
      },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "nothing answers" }, makeCtx());

    expect(result.status).toBe("error");
    expect(result.details.provider).toBe("exa");
    expect(result.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(result.details.failures).toHaveLength(2);
    expect(result.summary).toContain("exa: free limit reached (HTTP 429)");
    expect(result.summary).toContain(
      "duckduckgo: could not connect (site unreachable from this network)",
    );
    expect(result.summary).toContain("https://dashboard.exa.ai/api-keys");
    // The whole report reaches the model, action line included.
    expect(result.summary).toContain("Do not repeat this search");
    expect(result.truncated).toBe(false);
  });

  it("tells the terminal UI to open /integrations when all fail (ATO-345)", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": {
        body: "",
        status: 0,
        exitCode: 28,
        stderr: "curl: (28) Connection timed out after 15005 milliseconds",
      },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
      keyHelp: "integrations-hub",
    });

    const result = await tool.run({ query: "nothing answers" }, makeCtx());

    expect(result.status).toBe("error");
    expect(result.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(result.summary).toContain(
      "Free Exa searches ran out. Open /integrations and add an Exa key (https://dashboard.exa.ai/api-keys)",
    );
    expect(result.summary).not.toContain("key card");
    expect(result.summary).not.toContain("~/.atomic-agent/.env");
  });

  it("keeps the desktop and .env advice when no key help is given", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": {
        body: "",
        status: 0,
        exitCode: 28,
        stderr: "curl: (28) Connection timed out after 15005 milliseconds",
      },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "nothing answers" }, makeCtx());

    expect(result.summary).toContain(
      "In the desktop app, paste it into the key card in the chat or in Settings.",
    );
    expect(result.summary).not.toContain("/integrations");
  });

  it("adds one /integrations line, once per session, when a fallback answered for a spent Exa (ATO-345)", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { run } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": { body: RESULT_HTML, status: 200 },
    });
    const build = (keyHelp?: "integrations-hub") =>
      buildOsWebSearchTool({
        config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
        env: {},
        warn: () => undefined,
        runCommand: run,
        lookup: publicLookup,
        ...(keyHelp ? { keyHelp } : {}),
      });
    const hint =
      "[search] Free Exa searches ran out. Tell the user: open /integrations and add an Exa key (https://dashboard.exa.ai/api-keys).";

    const tui = build("integrations-hub");
    const first = await tui.run({ query: "first" }, makeCtx());
    const second = await tui.run({ query: "second" }, makeCtx());
    const otherSession = await tui.run(
      { query: "third" },
      { ...makeCtx(), sessionId: "s2" },
    );

    expect(first.status).toBe("ok");
    expect(first.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(first.summary.split(hint)).toHaveLength(2);
    expect(second.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(second.summary).not.toContain("/integrations");
    expect(otherSession.summary).toContain(hint);

    // Desktop and headless runs keep the result as it was.
    const desktop = await build().run({ query: "first" }, makeCtx());
    expect(desktop.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(desktop.summary).not.toContain("/integrations");
  });

  it("uses a key set mid-session on the next search, without a restart (ATO-345)", async () => {
    // The Integrations hub writes the key into process.env; the provider
    // reads it per call, and the free-tier park must not hold it back.
    vi.stubEnv("EXA_API_KEY", "");
    const { run, urls } = makeRecordingRunCommand({
      "exa.ai": FREE_LIMIT,
      "duckduckgo.com": { body: RESULT_HTML, status: 200 },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      env: {},
      warn: () => undefined,
      runCommand: run,
      lookup: publicLookup,
      keyHelp: "integrations-hub",
    });

    const before = await tool.run({ query: "before the key" }, makeCtx());
    expect(before.details.keyRequired).toEqual(KEY_REQUIRED_RATE_LIMITED);
    expect(urls.some((url) => url.includes("api.exa.ai"))).toBe(false);

    vi.stubEnv("EXA_API_KEY", "saved-in-the-hub");
    const after = await tool.run({ query: "after the key" }, makeCtx());

    expect(urls.some((url) => url.includes("api.exa.ai"))).toBe(true);
    expect(after.details.keyRequired).toBeUndefined();
  });

  it("answers ok when a keyed Exa fails and DuckDuckGo covers for it", async () => {
    // The desktop drew "Exa returned HTTP 403" as a failed tool row even
    // when the search went on to succeed. It is a note now, not the error.
    vi.stubEnv("EXA_API_KEY", "k");
    const { run, urls } = makeRecordingRunCommand({
      "exa.ai": { body: "Forbidden", status: 403 },
      "duckduckgo.com": { body: RESULT_HTML, status: 200 },
    });
    const tool = buildOsWebSearchTool({
      config: makeConfig({ provider: "exa", fallback: ["duckduckgo"] }),
      runCommand: run,
      lookup: publicLookup,
    });

    const result = await tool.run({ query: "keyed exa" }, makeCtx());

    expect(urls.some((url) => url.includes("api.exa.ai"))).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.details.provider).toBe("duckduckgo");
    expect(result.details.degraded).toEqual([
      "exa failed: Exa API returned HTTP 403",
    ]);
    // A key is set: a key card would not fix anything.
    expect(result.details.keyRequired).toBeUndefined();
    expect(result.summary).toContain("Example Doc");
  });
});
