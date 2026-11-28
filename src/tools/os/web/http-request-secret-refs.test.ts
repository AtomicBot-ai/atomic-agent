import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../../config/index.js";
import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import type { CommandOptions, CommandResult } from "../../../sandbox/command-runner.js";
import { resetResolvedSecretValues } from "../../../sandbox/resolved-secret-values.js";
import { ToolRegistry, type ToolContext } from "../../tool-registry.js";
import { buildHttpApprovalPreview } from "./http-request-preview.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

// `{{secret:NAME}}` in os.http.request header values (ATO-2530).

const VALUE = "Http4Secret5Value6Xyz";

/** `GH_TOKEN` only. It does not register the value for masking itself. */
function source(resolved: string[] = [], value = VALUE): ToolSecretSource {
  return {
    has: (name) => name === "GH_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return value;
    },
  };
}

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function meta(status: number, redirectUrl = ""): string {
  return `__ATOMIC_CURL_META__${status}|text/plain|2|0.01|${redirectUrl}__ATOMIC_CURL_RA__`;
}

function result(stdout: string): CommandResult {
  return {
    command: "curl",
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
  };
}

/** The header lines each curl run read from its `-H @file`, read while the file exists. */
function recordingRun(replies: string[]) {
  const calls: { headers: string[]; argv: string[] }[] = [];
  const run = async (_cmd: string, args: string[], _opts: CommandOptions): Promise<CommandResult> => {
    const headers: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const next = args[i + 1];
      if (args[i] === "-H" && next?.startsWith("@") && next !== "@-") {
        headers.push(...readFileSync(next.slice(1), "utf8").split("\n").filter((l) => l.length > 0));
      }
    }
    calls.push({ headers, argv: args });
    return result(replies[Math.min(calls.length - 1, replies.length - 1)]!);
  };
  return { calls, run };
}

function config(approvalMode: "never" | "writes" = "writes"): Pick<AtomicAgentConfig, "http"> {
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

function askingGate(asked: ApprovalRequest[]): ApprovalGate {
  const gate: ApprovalGate = new ApprovalGate({
    level: 1,
    emit: (req) => {
      asked.push(req);
      gate.resolve({ approvalId: req.approvalId, approved: true });
    },
  });
  return gate;
}

const ctx = (): ToolContext => ({
  workingDir: "/tmp/fixture",
  sessionId: "s-http-secrets",
  stepIndex: 0,
  signal: new AbortController().signal,
});

afterEach(() => resetResolvedSecretValues());

describe("os.http.request with {{secret:NAME}} in a header (ATO-2530)", () => {
  it("asks with the placeholder, then sends the value in the header only", async () => {
    const asked: ApprovalRequest[] = [];
    const resolved: string[] = [];
    const { calls, run } = recordingRun([`ok\n${meta(200)}`]);
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: askingGate(asked),
      approvalRequired: true,
      // "never" asks nobody, except a request handed a secret.
      config: config("never"),
      runCommand: run,
      secrets: source(resolved),
    });
    const out = await tool.run(
      { url: "https://api.example.com/user", headers: { Authorization: "Bearer {{secret:GH_TOKEN}}" } },
      ctx(),
    );
    expect(out.status).toBe("ok");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.category).toBe("shell_secret");
    expect(asked[0]!.grantKey).toBeUndefined();
    expect(asked[0]!.preview).toContain("Authorization: Bearer {{secret:GH_TOKEN}}");
    expect(asked[0]!.reason).toContain("uses secret GH_TOKEN: filled in when it is sent");
    expect(JSON.stringify(asked[0])).not.toContain(VALUE);
    expect(resolved).toEqual(["GH_TOKEN"]);
    expect(calls[0]!.headers).toContain(`Authorization: Bearer ${VALUE}`);
    // Never in argv (`ps`), the result or its details.
    expect(calls[0]!.argv.join(" ")).not.toContain(VALUE);
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it("fails an unknown or malformed name before any question or request", async () => {
    for (const header of ["Bearer {{secret:OTHER}}", "Bearer {{secret:bad-name}}"]) {
      const asked: ApprovalRequest[] = [];
      const resolved: string[] = [];
      const { calls, run } = recordingRun([`ok\n${meta(200)}`]);
      const tool = buildOsHttpRequestTool({
        lookup: publicLookup,
        approvals: askingGate(asked),
        approvalRequired: true,
        config: config(),
        runCommand: run,
        secrets: source(resolved),
      });
      const out = await tool.run({ url: "https://api.example.com/", headers: { Authorization: header } }, ctx());
      expect(out.status).toBe("error");
      expect(asked).toEqual([]);
      expect(calls).toEqual([]);
      expect(resolved).toEqual([]);
    }
  });

  it("refuses a placeholder in the URL or the body instead of sending it as written", async () => {
    const { calls, run } = recordingRun([`ok\n${meta(200)}`]);
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: askingGate([]),
      approvalRequired: true,
      config: config(),
      runCommand: run,
      secrets: source(),
    });
    const inUrl = await tool.run({ url: "https://api.example.com/?k={{secret:GH_TOKEN}}" }, ctx());
    expect(inUrl.summary).toContain("only in a header value");
    const inBody = await tool.run(
      { url: "https://api.example.com/", method: "POST", body: { token: "{{secret:GH_TOKEN}}" } },
      ctx(),
    );
    expect(inBody.summary).toContain("only in a header value");
    expect(calls).toEqual([]);
  });

  it("drops a filled header on a redirect to another origin, whatever its name", async () => {
    const { calls, run } = recordingRun([
      `\n${meta(302, "https://elsewhere.example/landing")}`,
      `ok\n${meta(200)}`,
    ]);
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: askingGate([]),
      approvalRequired: true,
      config: config(),
      runCommand: run,
      secrets: source(),
    });
    // `X-Github-Login` is not a credential-shaped name.
    await tool.run(
      { url: "https://api.example.com/start", headers: { "X-Github-Login": "{{secret:GH_TOKEN}}" } },
      ctx(),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers).toContain(`X-Github-Login: ${VALUE}`);
    expect(calls[1]!.headers.join("\n")).not.toContain(VALUE);
  });

  it("masks the value when the response echoes it back", async () => {
    const { run } = recordingRun([`you sent ${VALUE}\n${meta(200)}`]);
    const registry = new ToolRegistry({ knownSecrets: () => [] });
    registry.register(
      buildOsHttpRequestTool({
        lookup: publicLookup,
        approvals: askingGate([]),
        approvalRequired: true,
        config: config(),
        runCommand: run,
        secrets: source(),
      }),
    );
    const out = await registry.invoke(
      "os.http.request",
      { url: "https://api.example.com/echo", headers: { Authorization: "token {{secret:GH_TOKEN}}" } },
      ctx(),
    );
    expect(out.summary).toContain("you sent");
    expect(out.summary).not.toContain(VALUE);
  });

  it("refuses a value that would break the header line", async () => {
    const { calls, run } = recordingRun([`ok\n${meta(200)}`]);
    const tool = buildOsHttpRequestTool({
      lookup: publicLookup,
      approvals: askingGate([]),
      approvalRequired: true,
      config: config(),
      runCommand: run,
      secrets: source([], "Line1Value\r\nX-Evil: 1"),
    });
    const out = await tool.run(
      { url: "https://api.example.com/", headers: { Authorization: "Bearer {{secret:GH_TOKEN}}" } },
      ctx(),
    );
    expect(out.status).toBe("error");
    expect(out.summary).not.toContain("X-Evil");
    expect(calls).toEqual([]);
  });
});

describe("buildHttpApprovalPreview with a placeholder (ATO-2530)", () => {
  it("shows the secret's name and still masks literal credentials", () => {
    const preview = buildHttpApprovalPreview({
      method: "GET",
      url: "https://api.example.com/",
      headers: {
        Authorization: "Bearer {{secret:GH_TOKEN}}",
        "X-Api-Key": "literal-key-123 {{secret:GH_TOKEN}}",
        "X-Other-Token": "plain-literal-token",
      },
      body: undefined,
    });
    expect(preview).toContain("Authorization: Bearer {{secret:GH_TOKEN}}");
    expect(preview).toContain("X-Api-Key: **** with {{secret:GH_TOKEN}}");
    expect(preview).not.toContain("literal-key-123");
    expect(preview).toContain("X-Other-Token: ****");
  });
});
