import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolContext } from "../tool-registry.js";
import { buildVerifyRunTool } from "./verify-run.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";
import { guardVerifyCommand, guardVerifyRun, verifyRunCommands } from "./verify-run-guard.js";

// ATO-1266: verify.run used to start any command without the shell
// guard, so `rm -rf ~` in the "throwaway copy" reached the real home.

const CONFIG: Pick<AtomicAgentConfig, "browser"> = {
  browser: {
    enabled: true,
    channel: "chrome",
    headless: true,
    cdpUrl: null,
    connect: "agent",
    userChromeDataDir: null,
    executablePath: null,
    noSandbox: false,
    launchTimeoutMs: 1_000,
    blockedDomains: [],
    allowedDomains: [],
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
  work = await mkdtemp(join(tmpdir(), "atag-verify-guard-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
}

describe("verifyRunCommands", () => {
  it("lists the command, a service's start, a page's start, and nothing for a plain page", () => {
    expect(verifyRunCommands(parseVerifyRunArgs({ kind: "command", cmd: "npm", args: ["test"] }))).toEqual([
      { cmd: "npm", args: ["test"] },
    ]);
    expect(
      verifyRunCommands(
        parseVerifyRunArgs({ kind: "service", start: { cmd: "node", args: ["server.js"] }, ready: { port: 3000 } }),
      ),
    ).toEqual([{ cmd: "node", args: ["server.js"] }]);
    expect(
      verifyRunCommands(
        parseVerifyRunArgs({ kind: "page", url: "http://127.0.0.1:5173/", start: { cmd: "npx", args: ["vite"] } }),
      ),
    ).toEqual([{ cmd: "npx", args: ["vite"] }]);
    expect(verifyRunCommands(parseVerifyRunArgs({ kind: "page", path: "index.html" }))).toEqual([]);
  });
});

describe("guardVerifyRun", () => {
  it("blocks a hardline command, argv or command line", () => {
    const argv = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "rm", args: ["-rf", "~"] }), work);
    expect(argv.blocked?.verdict).toMatchObject({ action: "block", rule: "hardline.rm_home" });
    const line = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "cd .. && rm -rf /" }), work);
    expect(line.blocked?.verdict.action).toBe("block");
    expect(line.blocked?.verdict.rule).toMatch(/^hardline\./);
  });

  it("blocks a hardline service start", () => {
    const out = guardVerifyRun(
      parseVerifyRunArgs({ kind: "service", start: { cmd: "rm", args: ["-rf", "/"] }, ready: { port: 3000 } }),
      work,
    );
    expect(out.blocked?.verdict.rule).toBe("hardline.rm_root");
  });

  it("marks a dangerous command without blocking it", () => {
    const out = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "rm", args: ["-rf", "./build"] }), work);
    expect(out.blocked).toBeNull();
    expect(out.dangerous.map((c) => c.verdict.rule)).toEqual(["dangerous.rm_recursive"]);
  });

  it("leaves an ordinary test command alone", () => {
    const out = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "npm", args: ["test"] }), work);
    expect(out).toEqual({ blocked: null, dangerous: [] });
  });

  it("applies the operator's git policy when one is given", () => {
    const off = { isGitRemoteSyncEnabled: () => false };
    expect(guardVerifyCommand("git", ["push"], work, off).action).toBe("block");
    expect(guardVerifyCommand("git", ["push"], work).action).not.toBe("block");
  });
});

describe("verify.run behind the shell guard", () => {
  it("refuses a hardline command at every level and never asks or runs it", async () => {
    const marker = join(work, "keep.txt");
    await writeFile(marker, "x");
    for (const approvalRequired of [true, false]) {
      const { gate, request } = fakeGate({ scoped: true });
      const tool = buildVerifyRunTool({ approvals: gate, approvalRequired, config: CONFIG });
      const out = await tool.run({ kind: "command", cmd: "rm", args: ["-rf", "~"] }, ctx());
      expect(out.status).toBe("error");
      expect(out.summary).toMatch(/^verify\.run: blocked by shell guard: hardline\.rm_home/);
      expect(out.details).toMatchObject({ guardVerdict: "block", guardRule: "hardline.rm_home" });
      expect(request).not.toHaveBeenCalled();
    }
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it("asks a dangerous command as shell_dangerous even inside a fan-out scope", async () => {
    const { gate, request } = fakeGate({ scoped: true });
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG });
    await tool.run({ kind: "command", cmd: "rm", args: ["-rf", "./build"], checks: ["exit 0"] }, ctx());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      tool: "verify.run",
      category: "shell_dangerous",
      preview: "rm -rf ./build",
    });
    expect(String(request.mock.calls[0]?.[0]?.reason)).toContain("recursive remove");
    expect(request.mock.calls[0]?.[0]?.commandShape).toBeUndefined();
  });

  it("keeps an ordinary check covered by the fan-out scope and asking as shell outside it", async () => {
    const run = { kind: "command", cmd: process.execPath, args: ["-e", "0"], checks: ["exit 0"] };
    const scoped = fakeGate({ scoped: true });
    await buildVerifyRunTool({ approvals: scoped.gate, approvalRequired: true, config: CONFIG }).run(run, ctx());
    expect(scoped.request).not.toHaveBeenCalled();
    const plain = fakeGate();
    await buildVerifyRunTool({ approvals: plain.gate, approvalRequired: true, config: CONFIG }).run(run, ctx());
    expect(plain.request.mock.calls[0]?.[0]).toMatchObject({ category: "shell" });
  });

  it("refuses a git push when the operator switched remote sync off", async () => {
    const { gate, request } = fakeGate();
    const tool = buildVerifyRunTool({
      approvals: gate,
      approvalRequired: false,
      config: CONFIG,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const out = await tool.run({ kind: "command", cmd: "git", args: ["push"] }, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toContain("blocked by shell guard");
    expect(request).not.toHaveBeenCalled();
  });
});
