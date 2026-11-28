import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { resetResolvedSecretValues } from "../../sandbox/resolved-secret-values.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";
import { fillVerifySecrets } from "./verify-run-secrets.js";
import { buildVerifyRunTool } from "./verify-run.js";

// `{{secret:NAME}}` in verify.run commands and env (ATO-2530).

const VALUE = "Verify1Secret2Value3Q";

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

function source(resolved: string[] = [], value = VALUE): ToolSecretSource {
  return {
    has: (name) => name === "DEMO_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return value;
    },
  };
}

/** A gate that approves and records; `scoped` says a fan-out scope covers the folder. */
function fakeGate(scoped = false): { gate: ApprovalGate; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ approved: true, reason: "test" }));
  const gate = { request, fanoutScopes: { allows: () => scoped } } as unknown as ApprovalGate;
  return { gate, request };
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "atag-verify-secrets-"));
});
afterEach(async () => {
  resetResolvedSecretValues();
  await rm(work, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

const PROBE = `const v=${JSON.stringify(VALUE)};console.log("arg=" + (process.argv[1] === v) + " env=" + (process.env.DEMO_TOKEN === v) + " echo=" + process.argv[1])`;

describe("verify.run with {{secret:NAME}}", () => {
  it("asks as shell_secret even inside a fan-out scope, fills after approval, and keeps the placeholder in what it shows", async () => {
    const { gate, request } = fakeGate(true);
    const resolved: string[] = [];
    const registry = new ToolRegistry({ knownSecrets: () => [] });
    registry.register(buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG, secrets: source(resolved) }));
    const out = await registry.invoke(
      "verify.run",
      {
        kind: "command",
        cmd: process.execPath,
        args: ["-e", PROBE, "{{secret:DEMO_TOKEN}}"],
        env: { DEMO_TOKEN: "{{secret:DEMO_TOKEN}}" },
        checks: ["exit 0"],
      },
      ctx(),
    );
    expect(request).toHaveBeenCalledTimes(1);
    const asked = request.mock.calls[0]![0] as { category: string; reason: string; preview: string };
    expect(asked.category).toBe("shell_secret");
    expect(asked.reason).toContain("uses secret DEMO_TOKEN");
    expect(asked.preview).toContain("{{secret:DEMO_TOKEN}}");
    expect(JSON.stringify(asked)).not.toContain(VALUE);
    expect(resolved).toEqual(["DEMO_TOKEN"]);
    expect(out.summary).toContain("arg=true env=true");
    expect(out.summary).not.toContain(VALUE);
    expect(String(out.details.commandLine)).toContain("{{secret:DEMO_TOKEN}}");
    expect(String(out.details.commandLine)).not.toContain(VALUE);
  }, 20_000);

  it("fails an unknown secret, or one as the program, before any question", async () => {
    const { gate, request } = fakeGate();
    const resolved: string[] = [];
    const tool = buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG, secrets: source(resolved) });
    const unknown = await tool.run({ kind: "command", cmd: "echo", args: ["{{secret:OTHER}}"] }, ctx());
    expect(unknown.status).toBe("error");
    expect(unknown.summary).toContain("unknown secret OTHER");
    const program = await tool.run({ kind: "command", cmd: "{{secret:DEMO_TOKEN}}", args: ["x"] }, ctx());
    expect(program.summary).toContain("cannot be the program name");
    expect(request).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
  });

  it("refuses a value a shell would read as syntax, and a fill the guard reads differently", async () => {
    // `cmd` with a space and no args runs as a shell line.
    const line = parseVerifyRunArgs({ kind: "command", cmd: "echo {{secret:DEMO_TOKEN}}" });
    const syntax = await fillVerifySecrets(line, ["DEMO_TOKEN"], source([], "abc123;rm -rf ~"), () => true);
    expect(syntax).toMatchObject({ ok: false, message: expect.stringContaining("shell would read as syntax") });
    const args = parseVerifyRunArgs({ kind: "command", cmd: "echo", args: ["{{secret:DEMO_TOKEN}}"] });
    const otherRule = await fillVerifySecrets(args, ["DEMO_TOKEN"], source(), () => false);
    expect(otherRule).toMatchObject({ ok: false, message: expect.stringContaining("reads differently") });
    const plain = await fillVerifySecrets(args, ["DEMO_TOKEN"], source(), () => true);
    expect(plain).toMatchObject({ ok: true, args: { cmd: "echo", args: [VALUE] } });
  });

  it("fills a service's start command, not only kind command", async () => {
    const args = parseVerifyRunArgs({
      kind: "service",
      start: { cmd: "node", args: ["server.js", "--token={{secret:DEMO_TOKEN}}"] },
      ready: { port: 4000 },
    });
    const filled = await fillVerifySecrets(args, ["DEMO_TOKEN"], source(), () => true);
    expect(filled).toMatchObject({ ok: true, args: { start: { cmd: "node", args: ["server.js", `--token=${VALUE}`] } } });
  });
});
