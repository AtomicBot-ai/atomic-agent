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
    expect(
      describeVerifyRun(parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "python3", args: ["-m", "http.server", "8766"] }, seconds: 2 })),
    ).toBe("start `python3 -m http.server 8766`, then open http://127.0.0.1:8766/ headless for 2s");
  });
});

describe("parseVerifyRunArgs, page with start", () => {
  it("keeps `start` and waits for the page url by default", () => {
    const args = parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/index.html", start: { cmd: "python3", args: ["-m", "http.server", "8766"] } });
    expect(args.start).toEqual({ cmd: "python3", args: ["-m", "http.server", "8766"] });
    expect(args.ready).toMatchObject({ url: "http://127.0.0.1:8766/index.html", port: undefined });
  });

  it("uses an explicit ready port or url instead", () => {
    expect(parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "x" }, ready: { port: 8766 } }).ready).toMatchObject({ port: 8766, url: undefined });
    expect(parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "x" }, ready: { url: "http://127.0.0.1:8766/health" } }).ready).toMatchObject({ url: "http://127.0.0.1:8766/health" });
  });

  it("refuses `start` with a file path", () => {
    expect(() => parseVerifyRunArgs({ kind: "page", path: "index.html", start: { cmd: "x" } })).toThrow("page with `start` needs `url`");
  });
});

describe("parseVerifyRunArgs, empty-string defaults (ATO-891)", () => {
  it("does not count an empty path or url as the second side of a page", () => {
    expect(parseVerifyRunArgs({ kind: "page", path: "", url: "http://127.0.0.1:8766/" })).toMatchObject({ path: undefined, url: "http://127.0.0.1:8766/" });
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", url: "" })).toMatchObject({ path: "index.html", url: undefined });
  });

  it("does not count an empty path or url as the second side of a request", () => {
    const args = parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 3000, url: "" }, requests: [{ path: "/", url: "" }, { path: "", url: "http://127.0.0.1:3000/health" }] });
    expect(args.ready).toMatchObject({ port: 3000, url: undefined });
    expect(args.requests).toMatchObject([{ path: "/", url: undefined }, { path: undefined, url: "http://127.0.0.1:3000/health" }]);
  });

  it("keeps a lone empty request path, which means the service root", () => {
    const args = parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 3000 }, requests: [{ path: "" }] });
    expect(args.requests).toMatchObject([{ path: "", url: undefined }]);
    expect(() => parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 3000 }, requests: [{ path: "", url: "" }] })).toThrow("requests[0] needs exactly one of `path` or `url`");
  });

  it("falls back to the page url when ready.url is empty", () => {
    expect(parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "x" }, ready: { url: "" } }).ready).toMatchObject({ url: "http://127.0.0.1:8766/" });
  });

  it("still refuses a real double form and a missing one", () => {
    expect(() => parseVerifyRunArgs({ kind: "page", path: "index.html", url: "http://127.0.0.1:8766/" })).toThrow("page needs exactly one of `path` or `url`");
    expect(() => parseVerifyRunArgs({ kind: "page", path: "", url: "" })).toThrow("page needs exactly one of `path` or `url`");
    expect(() => parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 3000 }, requests: [{ path: "/", url: "http://x/" }] })).toThrow("requests[0] needs exactly one of `path` or `url`");
  });
});

describe("parseVerifyRunArgs, zero-filled ready.port and start", () => {
  it("treats ready.port 0 as absent on a page with start: readiness falls back to the page url", () => {
    const args = parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "python3", args: ["-m", "http.server", "8766"] }, ready: { port: 0, url: "" } });
    expect(args.ready).toMatchObject({ port: undefined, url: "http://127.0.0.1:8766/" });
  });

  it("treats ready.port 0 as absent on a service", () => {
    expect(parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 0, url: "http://127.0.0.1:3000/health" } }).ready).toMatchObject({ port: undefined, url: "http://127.0.0.1:3000/health" });
    expect(() => parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 0, url: "" } })).toThrow("service needs `ready.port` or `ready.url`");
    expect(parseVerifyRunArgs({ kind: "service", start: { cmd: "node" }, ready: { port: 3000 } }).ready).toMatchObject({ port: 3000 });
  });

  it("treats a start with an empty cmd as absent on a path-only page", () => {
    const args = parseVerifyRunArgs({ kind: "page", path: "index.html", start: { cmd: "", args: [] }, ready: { port: 0, url: "" } });
    expect(args).toMatchObject({ path: "index.html", url: undefined });
    expect(args.start).toBeUndefined();
    expect(parseVerifyRunArgs({ kind: "page", path: "index.html", start: { cmd: "   " } }).start).toBeUndefined();
    expect(() => parseVerifyRunArgs({ kind: "page", path: "index.html", start: { cmd: "python3" } })).toThrow("page with `start` needs `url`");
    expect(() => parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { args: ["x"] } })).toThrow("start.cmd");
    expect(() => parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:8766/", start: { cmd: "", args: ["-m", "http.server"] } })).toThrow("start.cmd");
  });
});
