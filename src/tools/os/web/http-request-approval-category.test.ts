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
import { buildOsHttpRequestTool, httpApprovalCategory } from "./http-request.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * ATO-1462: a request that sends data asks as `http_write`, which goes
 * quiet only from level 4; a GET stays `http` (quiet from level 3). An
 * `http` session grant never answers a POST.
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

function buildTool(gate: ApprovalGate, mode: HttpApprovalMode = "writes") {
  return buildOsHttpRequestTool({
    lookup: publicLookup,
    approvals: gate,
    approvalRequired: true,
    config: httpConfig(mode),
    runCommand: okCurl(),
  });
}

const post = { url: "https://example.com/upload", method: "POST", body: "secret" };

describe("os.http.request approval category (ATO-1462)", () => {
  it("names http for reads and http_write for anything else", () => {
    expect(httpApprovalCategory("GET")).toBe("http");
    expect(httpApprovalCategory("head")).toBe("http");
    expect(httpApprovalCategory("OPTIONS")).toBe("http");
    expect(httpApprovalCategory("POST")).toBe("http_write");
    expect(httpApprovalCategory("PUT")).toBe("http_write");
    expect(httpApprovalCategory("DELETE")).toBe("http_write");
  });

  it("asks before a POST at level 3", async () => {
    const { gate, asked } = recordingGate(3);
    await expect(buildTool(gate).run(post, makeCtx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.category).toBe("http_write");
  });

  it("runs a POST without asking at level 4", async () => {
    const { gate, asked } = recordingGate(4);
    const result = await buildTool(gate).run(post, makeCtx());
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(0);
  });

  it("runs a GET without asking at level 3, even when every call goes to the gate", async () => {
    const { gate, asked } = recordingGate(3);
    const result = await buildTool(gate, "always").run(
      { url: "https://example.com/data" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(0);
  });

  it("asks a GET as http below level 3", async () => {
    const { gate, asked } = recordingGate(2);
    await expect(
      buildTool(gate, "always").run({ url: "https://example.com/data" }, makeCtx()),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(asked[0]!.category).toBe("http");
  });

  it("does not let an http session grant cover a POST to the same origin", async () => {
    // Level 2: a GET asks too, so it can be granted for the session.
    const { gate, asked } = recordingGate(2, (req, g) => {
      if (req.category === "http") {
        g.resolve({ approvalId: req.approvalId, approved: true, grant: "category" });
      } else {
        g.reject(req.approvalId, "denied");
      }
    });
    const tool = buildTool(gate, "always");

    await tool.run({ url: "https://example.com/data" }, makeCtx());
    expect(asked).toHaveLength(1);
    // The grant covers the next GET to that origin.
    await tool.run({ url: "https://example.com/other" }, makeCtx());
    expect(asked).toHaveLength(1);

    // A POST to the same origin still asks, under its own category.
    await expect(tool.run(post, makeCtx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(asked).toHaveLength(2);
    expect(asked[1]!.category).toBe("http_write");
  });
});
