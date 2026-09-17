import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolContext } from "../tool-registry.js";
import { buildVerifyRunTool, describeVerifyRun } from "./verify-run.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";

const CONFIG: Pick<AtomicAgentConfig, "browser"> = {
  browser: {
    enabled: true,
    channel: "chrome",
    headless: true,
    cdpUrl: null,
    executablePath: null,
    noSandbox: false,
    launchTimeoutMs: 1_000,
  },
};

function fakeGate(over: { approved?: boolean; scoped?: boolean } = {}): {
  gate: ApprovalGate;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => ({ approved: over.approved ?? true, reason: "test" }));
  const gate = {
    request,
    fanoutScopes: { allows: () => over.scoped ?? false },
  } as unknown as ApprovalGate;
  return { gate, request };
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "atag-verify-tool-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
}

const RUN_NODE = { kind: "command", cmd: process.execPath, args: ["-e", "console.log('ran')"], checks: ["exit 0"] };

describe("verify.run tool", () => {
  it("is read-only, asks under the shell category, and runs once approved", async () => {
    const { gate, request } = fakeGate();
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG });
    expect(tool.readonly).toBe(true);
    const out = await tool.run(RUN_NODE, ctx());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "s1",
      tool: "verify.run",
      category: "shell",
      affectedResources: [work],
    });
    expect(out.status).toBe("ok");
    expect(out.summary.split("\n")[0]).toBe("verify.run command: ok");
    expect(out.details).toMatchObject({ ok: true, kind: "command", isolated: true, exitCode: 0 });
    expect(out.details.description).toBe(`${process.execPath} -e console.log('ran')`);
  });

  it("surfaces a denial as the shared ApprovalDeniedError", async () => {
    const { gate } = fakeGate({ approved: false });
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG });
    await expect(tool.run(RUN_NODE, ctx())).rejects.toBeInstanceOf(ApprovalDeniedError);
  });

  it("does not ask inside an authorised fan-out scope, nor with approvals off", async () => {
    const scoped = fakeGate({ scoped: true });
    await buildVerifyRunTool({ approvals: scoped.gate, approvalRequired: true, config: CONFIG }).run(RUN_NODE, ctx());
    expect(scoped.request).not.toHaveBeenCalled();
    const off = fakeGate();
    await buildVerifyRunTool({ approvals: off.gate, approvalRequired: false, config: CONFIG }).run(RUN_NODE, ctx());
    expect(off.request).not.toHaveBeenCalled();
  });

  it("answers a bad argument with an error result naming the field, before asking anyone", async () => {
    const { gate, request } = fakeGate();
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG });
    const out = await tool.run({ kind: "service", start: { cmd: "x" } }, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toBe("verify.run: service needs `ready.port` or `ready.url`");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a failing run as an error result with the failing checks first", async () => {
    const { gate } = fakeGate();
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: false, config: CONFIG });
    const out = await tool.run(
      { kind: "command", cmd: process.execPath, args: ["-e", "process.exit(2)"], checks: ["exit 0"] },
      ctx(),
    );
    expect(out.status).toBe("error");
    expect(out.summary.split("\n").slice(0, 2)).toEqual([
      "verify.run command: FAILED",
      "FAIL check `exit 0` — exit 2",
    ]);
  });
});

describe("describeVerifyRun", () => {
  it("names what will run, per kind", () => {
    expect(describeVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "npm", args: ["test"] }))).toBe("npm test");
    expect(
      describeVerifyRun(parseVerifyRunArgs({ kind: "service", start: { cmd: "node", args: ["server.js"] }, ready: { port: 3000 }, requests: [{ path: "/" }] })),
    ).toBe("start `node server.js`, then 1 request(s)");
    expect(describeVerifyRun(parseVerifyRunArgs({ kind: "page", path: "index.html", seconds: 3 }))).toBe("open index.html headless for 3s");
  });
});
