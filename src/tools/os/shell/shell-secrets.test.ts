import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import {
  rememberResolvedSecret,
  resetResolvedSecretValues,
} from "../../../sandbox/resolved-secret-values.js";
import { ToolRegistry, type ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";
import { checkShellSecrets, fillShellSecrets } from "./shell-secrets.js";

const VALUE = "Shell5Secret6Value7";

/** A fake source: `DEMO_TOKEN` only; registers its value like the real resolver. */
function source(resolved: string[] = []): ToolSecretSource {
  return {
    has: (name) => name === "DEMO_TOKEN",
    async resolve(name) {
      resolved.push(name);
      if (name !== "DEMO_TOKEN") throw new Error(`no tool secret named ${name}`);
      rememberResolvedSecret(name, VALUE);
      return VALUE;
    },
  };
}

afterEach(() => resetResolvedSecretValues());

describe("checkShellSecrets / fillShellSecrets", () => {
  it("fails an unknown name, and any name when no secrets are configured", () => {
    expect(checkShellSecrets("echo", ["{{secret:OTHER_TOKEN}}"], false, source())).toEqual({
      ok: false,
      message: expect.stringContaining("unknown secret OTHER_TOKEN"),
    });
    expect(checkShellSecrets("echo", ["{{secret:DEMO_TOKEN}}"], false, undefined)).toMatchObject({ ok: false });
    expect(checkShellSecrets("echo", ["plain"], false, undefined)).toEqual({ ok: true, names: [] });
  });

  it("refuses a placeholder as the program of a direct command", () => {
    expect(checkShellSecrets("{{secret:DEMO_TOKEN}}", ["-rf"], false, source())).toMatchObject({ ok: false });
  });

  it("resolves only when filling, and refuses when the guard would read the filled command differently", async () => {
    const resolved: string[] = [];
    const check = checkShellSecrets("echo", ["{{secret:DEMO_TOKEN}}"], false, source(resolved));
    expect(check).toEqual({ ok: true, names: ["DEMO_TOKEN"] });
    expect(resolved).toEqual([]);
    const filled = await fillShellSecrets("echo", ["x={{secret:DEMO_TOKEN}}"], false, ["DEMO_TOKEN"], source(resolved), () => true);
    expect(filled).toEqual({ ok: true, cmd: "echo", args: [`x=${VALUE}`] });
    const changed = await fillShellSecrets("echo", ["{{secret:DEMO_TOKEN}}"], false, ["DEMO_TOKEN"], source(), () => false);
    expect(changed).toMatchObject({ ok: false });
  });
});

describe.skipIf(process.platform === "win32")("os.shell.run with {{secret:NAME}} (ATO-476)", () => {
  let dir: string;
  let asked: ApprovalRequest[];
  let answer: (req: ApprovalRequest) => Omit<ApprovalDecision, "approvalId">;
  let gate: ApprovalGate;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-secrets-"));
    asked = [];
    answer = () => ({ approved: true });
    gate = new ApprovalGate({
      level: 1,
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, ...answer(req) });
      },
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    workingDir: dir,
    sessionId: "s-secrets",
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  function registry(secrets?: ToolSecretSource): ToolRegistry {
    const r = new ToolRegistry({ knownSecrets: () => [] });
    r.register(
      buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        ...(secrets === undefined ? {} : { secrets }),
      }),
    );
    return r;
  }

  it("asks with the placeholder and the secret's name, runs with the value, and shows the model a marker", async () => {
    const resolved: string[] = [];
    const result = await registry(source(resolved)).invoke(
      "os.shell.run",
      { cmd: "printf", args: ["%s", "{{secret:DEMO_TOKEN}}"] },
      ctx(),
    );
    // `printf` alone would run unasked; a secret always goes to the gate.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.category).toBe("shell_dangerous");
    expect(asked[0]!.preview).toContain("{{secret:DEMO_TOKEN}}");
    expect(asked[0]!.preview).not.toContain(VALUE);
    expect(asked[0]!.reason).toContain("uses secret DEMO_TOKEN");
    expect(resolved).toEqual(["DEMO_TOKEN"]);
    const seen = `${result.summary}\n${result.fullOutput ?? ""}\n${JSON.stringify(result.details)}`;
    expect(seen).not.toContain(VALUE);
    expect(seen).toContain("[redacted:DEMO_TOKEN]");
  });

  it("never fetches the value when the human declines", async () => {
    answer = () => ({ approved: false, reason: "no" });
    const resolved: string[] = [];
    await expect(
      registry(source(resolved)).invoke("os.shell.run", { cmd: "printf", args: ["{{secret:DEMO_TOKEN}}"] }, ctx()),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(resolved).toEqual([]);
  });

  it("fails an unknown name before asking anything", async () => {
    const result = await registry(source()).invoke(
      "os.shell.run",
      { cmd: "printf", args: ["{{secret:NOT_LISTED}}"] },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("unknown secret NOT_LISTED");
    expect(asked).toHaveLength(0);
  });

  it("fails every placeholder when no tool secrets are wired in", async () => {
    const result = await registry().invoke("os.shell.run", { cmd: "printf", args: ["{{secret:DEMO_TOKEN}}"] }, ctx());
    expect(result.status).toBe("error");
    expect(asked).toHaveLength(0);
  });
});
