import { describe, it, expect } from "vitest";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type {
  CommandOptions,
  CommandResult,
} from "../../sandbox/command-runner.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolContext } from "../tool-registry.js";
import {
  buildOsHttpRequestTool,
  hostAllowed,
  parseCurlOutput,
} from "./http-request.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp/fixture",
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeCommandResult(
  overrides: Partial<CommandResult>,
): CommandResult {
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
    ...overrides,
  };
}

function makeHttpConfig(
  overrides: Partial<AtomicAgentConfig["http"]> = {},
): Pick<AtomicAgentConfig, "http"> {
  return {
    http: {
      enabled: true,
      approvalMode: "writes",
      hostAllowlist: null,
      maxResponseBytes: 1_048_576,
      defaultTimeoutMs: 30_000,
      ...overrides,
    },
  };
}

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.reject(req.approvalId, "denied"),
  });
  return gate;
}

function fakeRun(
  capture: { cmd?: string; args?: string[]; opts?: CommandOptions },
  result: Partial<CommandResult> = {},
) {
  return async (
    cmd: string,
    args: string[],
    opts: CommandOptions,
  ): Promise<CommandResult> => {
    capture.cmd = cmd;
    capture.args = args;
    capture.opts = opts;
    return makeCommandResult(result);
  };
}

/** Hermetic lookup: public unicast address for any hostname. */
const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

function privateLookup(ip: string): HostLookup {
  return async () => [{ address: ip, family: 4 }];
}

function meta(
  status: number,
  contentType: string,
  size: number,
  time = 0.01,
  redirectUrl = "",
): string {
  return `__ATOMIC_CURL_META__${status}|${contentType}|${size}|${time}|${redirectUrl}`;
}

describe("hostAllowed", () => {
  it("returns true when allowlist is null", () => {
    expect(hostAllowed("api.github.com", null)).toBe(true);
  });

  it("matches exact hostnames case-insensitively", () => {
    expect(hostAllowed("API.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("evil.example", ["api.github.com"])).toBe(false);
  });

  it("matches *.domain wildcards on sub-domains and the bare domain", () => {
    const list = ["*.example.com"];
    expect(hostAllowed("a.example.com", list)).toBe(true);
    expect(hostAllowed("a.b.example.com", list)).toBe(true);
    expect(hostAllowed("example.com", list)).toBe(true);
    expect(hostAllowed("evil.com", list)).toBe(false);
  });
});

describe("parseCurlOutput", () => {
  it("splits body from meta marker", () => {
    const stdout =
      "hello world\n__ATOMIC_CURL_META__200|application/json; charset=utf-8|11|0.123|https://next.example/";
    const parsed = parseCurlOutput(stdout);
    expect(parsed.body).toBe("hello world");
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe("application/json; charset=utf-8");
    expect(parsed.sizeDownload).toBe(11);
    expect(parsed.timeTotal).toBeCloseTo(0.123);
    expect(parsed.redirectUrl).toBe("https://next.example/");
  });

  it("falls back to raw output if marker is missing", () => {
    const parsed = parseCurlOutput("raw body");
    expect(parsed.body).toBe("raw body");
    expect(parsed.status).toBe(0);
  });
});

describe("os.http.request", () => {
  it("rejects when config.http.enabled is false", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ enabled: false }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run({ url: "https://example.com" }, makeCtx()),
    ).rejects.toThrow(/disabled by config/);
  });

  it("rejects non-http(s) URLs", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig(),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run({ url: "ftp://example.com" }, makeCtx()),
    ).rejects.toThrow(/only http\/https/);
  });

  it("rejects hostnames not on the allowlist", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ hostAllowlist: ["api.github.com"] }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run({ url: "https://evil.example" }, makeCtx()),
    ).rejects.toThrow(/not in config.http.hostAllowlist/);
  });

  it("performs GET without approval when approvalMode=writes", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: denyAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "writes" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__200|text/plain|2|0.01',
      }),
    });
    const result = await tool.run(
      { url: "https://example.com" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.status).toBe(200);
    expect(capture.args!.some((a) => a.includes("example.com"))).toBe(true);
    expect(capture.args).not.toContain("-X");
  });

  it("returns status:error for a 404 while keeping the body in details", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'not found\n__ATOMIC_CURL_META__404|text/plain|9|0.01',
      }),
    });
    const result = await tool.run({ url: "https://example.com/missing" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("HTTP 404");
    expect(result.details.status).toBe(404);
    expect(result.details.body).toBe("not found");
  });

  it("returns status:error for a 500", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'boom\n__ATOMIC_CURL_META__500|text/plain|4|0.01',
      }),
    });
    const result = await tool.run({ url: "https://example.com/boom" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("HTTP 500");
    expect(result.details.status).toBe(500);
  });

  it("requires approval for POST when approvalMode=writes", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: denyAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "writes" }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run(
        { url: "https://example.com", method: "POST", body: "{}" },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("requires approval for GET when approvalMode=always", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: denyAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "always" }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run({ url: "https://example.com" }, makeCtx()),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("bypasses approval entirely when approvalMode=never", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: denyAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__201|text/plain|2|0.01',
      }),
    });
    const result = await tool.run(
      { url: "https://example.com", method: "POST", body: "{}" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.status).toBe(201);
  });

  it("serialises object body to JSON and auto-sets Content-Type", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__200|application/json|2|0.01',
      }),
    });
    await tool.run(
      {
        url: "https://api.example.com/echo",
        method: "POST",
        body: { hello: "world" },
      },
      makeCtx(),
    );
    expect(capture.args).toContain("-X");
    expect(capture.args).toContain("POST");
    expect(capture.args).toContain("--data-binary");
    expect(capture.args).toContain("@-");
    const contentTypeFlagIndex = capture.args!.findIndex(
      (arg, idx) =>
        arg === "-H" &&
        capture.args![idx + 1]?.toLowerCase().startsWith("content-type"),
    );
    expect(contentTypeFlagIndex).toBeGreaterThan(-1);
    expect(capture.opts?.input).toBe(JSON.stringify({ hello: "world" }));
  });

  it("passes custom headers through to curl and does not override them", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__200|text/plain|2|0.01',
      }),
    });
    await tool.run(
      {
        url: "https://api.example.com",
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: "Bearer XYZ",
        },
        body: "raw",
      },
      makeCtx(),
    );
    expect(capture.args).toContain("Content-Type: text/plain");
    expect(capture.args).toContain("Authorization: Bearer XYZ");
    const ctOccurrences = capture.args!.filter((a) =>
      a.toLowerCase().startsWith("content-type:"),
    );
    expect(ctOccurrences).toHaveLength(1);
  });

  it("injects a default Accept header when none is provided", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__200|text/plain|2|0.01',
      }),
    });
    await tool.run({ url: "https://mcp.exa.ai/mcp" }, makeCtx());
    expect(capture.args).toContain("Accept: application/json, text/event-stream");
  });

  it("does not override an explicit Accept header", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: 'ok\n__ATOMIC_CURL_META__200|application/json|2|0.01',
      }),
    });
    await tool.run(
      {
        url: "https://api.example.com",
        headers: { Accept: "application/xml" },
      },
      makeCtx(),
    );
    expect(capture.args).toContain("Accept: application/xml");
    const acceptOccurrences = capture.args!.filter((a) =>
      a.toLowerCase().startsWith("accept:"),
    );
    expect(acceptOccurrences).toHaveLength(1);
  });

  it("rejects headers containing CR/LF to prevent injection", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run(
        {
          url: "https://example.com",
          headers: { Evil: "value\r\nInjected: yes" },
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/CR\/LF/);
  });

  it("rejects body on GET requests", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}),
    });
    await expect(
      tool.run(
        { url: "https://example.com", method: "GET", body: "x" },
        makeCtx(),
      ),
    ).rejects.toThrow(/body.*GET/);
  });

  it("returns structured error when curl fails", async () => {
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        exitCode: 6,
        stderr: "curl: (6) Could not resolve host: does.not.exist",
      }),
    });
    const result = await tool.run(
      { url: "https://does.not.exist" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Could not resolve host");
    expect(result.details.exitCode).toBe(6);
  });

  it("returns the HTML body verbatim (extraction is os.web.fetch's job)", async () => {
    const html = [
      "<!doctype html>",
      "<html><head><title>T</title></head>",
      "<body><h1>Hello</h1>",
      "<p>This is <a href='https://x.test'>a link</a> in a paragraph.</p>",
      "</body></html>",
    ].join("\n");
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        stdout: `${html}\n__ATOMIC_CURL_META__200|text/html; charset=utf-8|${html.length}|0.01`,
      }),
    });
    const result = await tool.run(
      { url: "https://example.com" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.htmlStripped).toBeUndefined();
    expect(result.summary).toContain("<h1>Hello</h1>");
    expect(result.summary).toContain("<a href='https://x.test'>a link</a>");
    expect(result.truncated).toBe(false);
  });

  it("leaves JSON responses intact", async () => {
    const json = JSON.stringify({
      items: [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      cursor: "abc",
    });
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        stdout: `${json}\n__ATOMIC_CURL_META__200|application/json; charset=utf-8|${json.length}|0.01`,
      }),
    });
    const result = await tool.run(
      { url: "https://api.example.com/items" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.htmlStripped).toBeUndefined();
    expect(result.summary).toContain('"cursor":"abc"');
    expect(result.summary).toContain('"name":"b"');
    expect(result.truncated).toBe(false);
  });

  it("returns an HTML-looking body unchanged when content-type is missing", async () => {
    const html = "<!doctype html><html><body><p>Sniffed</p></body></html>";
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        stdout: `${html}\n__ATOMIC_CURL_META__200||${html.length}|0.01`,
      }),
    });
    const result = await tool.run(
      { url: "https://example.com" },
      makeCtx(),
    );
    expect(result.details.htmlStripped).toBeUndefined();
    expect(result.summary).toContain("<p>Sniffed</p>");
  });

  it("returns plain-text responses verbatim", async () => {
    const body = "if (a < b) return true; else return false;";
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        stdout: `${body}\n__ATOMIC_CURL_META__200|text/plain|${body.length}|0.01`,
      }),
    });
    const result = await tool.run(
      { url: "https://example.com" },
      makeCtx(),
    );
    expect(result.details.htmlStripped).toBeUndefined();
    expect(result.summary).toContain("a < b");
  });

  it("preserves a long JSON body without compressor truncation", async () => {
    const big = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ id: i, value: `row-${i}` })),
    );
    expect(big.length).toBeGreaterThan(2000);
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun({}, {
        stdout: `${big}\n__ATOMIC_CURL_META__200|application/json|${big.length}|0.01`,
      }),
    });
    const result = await tool.run(
      { url: "https://api.example.com/big" },
      makeCtx(),
    );
    expect(result.summary).toContain('"id":199');
    expect(result.summary).toContain('"value":"row-199"');
    expect(result.truncated).toBe(false);
  });

  it("uses config.http.defaultTimeoutMs when timeoutMs is not provided", async () => {
    const capture: { cmd?: string; args?: string[]; opts?: CommandOptions } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: true,
      config: makeHttpConfig({ defaultTimeoutMs: 7_000, approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: "ok\n" + meta(200, "text/plain", 2),
      }),
    });
    await tool.run({ url: "https://example.com" }, makeCtx());
    const maxTimeIdx = capture.args!.indexOf("--max-time");
    expect(maxTimeIdx).toBeGreaterThan(-1);
    expect(capture.args![maxTimeIdx + 1]).toBe("7");
  });

  it("blocks private IP literals (SSRF parity with os.web.fetch)", async () => {
    const capture: { cmd?: string; args?: string[] } = {};
    const tool = buildOsHttpRequestTool({
      // Hostname itself is the blocked IP — lookup must surface that address
      // (real DNS does this for literal IPs; do not substitute a public pin).
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: "ok\n" + meta(200, "text/plain", 2),
      }),
    });
    const result = await tool.run(
      { url: "http://169.254.169.254/latest/meta-data/" },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.blocked).toBe(true);
    expect(result.summary).toMatch(/private|internal|169\.254/i);
    expect(capture.args).toBeUndefined();
  });

  it("blocks hosts that DNS-resolve to a private address", async () => {
    const capture: { cmd?: string; args?: string[] } = {};
    const tool = buildOsHttpRequestTool({
      lookup: privateLookup("10.0.0.5"),
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture),
    });
    const result = await tool.run({ url: "https://evil.internal" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.blocked).toBe(true);
    expect(result.summary).toContain("10.0.0.5");
    expect(capture.args).toBeUndefined();
  });

  it("pins curl with --resolve and does not use bare -L", async () => {
    const capture: { cmd?: string; args?: string[] } = {};
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand: fakeRun(capture, {
        stdout: "ok\n" + meta(200, "text/plain", 2),
      }),
    });
    await tool.run({ url: "https://example.com/x" }, makeCtx());
    const resolveIdx = capture.args!.indexOf("--resolve");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(capture.args![resolveIdx + 1]).toBe("example.com:443:93.184.216.34");
    expect(capture.args).toContain("--max-redirs");
    expect(capture.args).not.toContain("-L");
  });

  it("re-validates redirect hops and blocks a private Location target", async () => {
    const calls: string[][] = [];
    const runCommand = async (
      _cmd: string,
      args: string[],
      _opts: CommandOptions,
    ): Promise<CommandResult> => {
      calls.push(args);
      if (calls.length === 1) {
        return makeCommandResult({
          stdout:
            "\n" +
            meta(302, "text/plain", 0, 0.01, "http://169.254.169.254/meta"),
        });
      }
      return makeCommandResult({
        stdout: "leaked\n" + meta(200, "text/plain", 6),
      });
    };
    // First hop is public; second hop would be private IP literal.
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: approveAll(),
      approvalRequired: false,
      config: makeHttpConfig({ approvalMode: "never" }),
      runCommand,
    });
    const result = await tool.run(
      { url: "https://example.com/start", followRedirects: true },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.blocked).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
