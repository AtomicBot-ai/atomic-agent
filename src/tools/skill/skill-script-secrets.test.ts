import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { resetResolvedSecretValues } from "../../sandbox/resolved-secret-values.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { buildSkillRunScriptTool } from "./skill-run-script.js";
import { parseScriptEnv } from "./skill-script-secrets.js";

// `{{secret:NAME}}` in skill.run_script args and env (ATO-2530).

const VALUE = "Skill7Secret8Value9Abc";

function source(resolved: string[] = []): ToolSecretSource {
  return {
    has: (name) => name === "DEMO_TOKEN",
    async resolve(name) {
      resolved.push(name);
      return VALUE;
    },
  };
}

describe("skill.run_script with {{secret:NAME}}", () => {
  let base: string;
  let asked: ApprovalRequest[];
  let gate: ApprovalGate;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-skill-secrets-"));
    asked = [];
    gate = new ApprovalGate({
      level: 1,
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
  });
  afterEach(async () => {
    resetResolvedSecretValues();
    await rm(base, { recursive: true, force: true });
  });

  /** A skill whose script reports whether it got the value, then echoes it. */
  async function installProbe(): Promise<SkillRegistry> {
    const dir = join(base, "skills", "probe");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: probe",
        'description: "Probes secrets"',
        "version: 0.1.0",
        "requires_scripts: [probe.js]",
        "env_keys: [DEMO_TOKEN]",
        "---",
        "",
        "Probe body.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "scripts", "probe.js"),
      `const v = ${JSON.stringify(VALUE)};
process.stdout.write("arg=" + (process.argv[2] === "--key=" + v) + " env=" + (process.env.DEMO_TOKEN === v) + " echo=" + process.env.DEMO_TOKEN);`,
      "utf8",
    );
    const registry = new SkillRegistry({ globalDir: join(base, "skills"), projectDir: null });
    await registry.refresh();
    return registry;
  }

  const ctx = (): ToolContext => ({
    workingDir: base,
    sessionId: "s-skill-secrets",
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  it("asks with the placeholders, fills args and env after approval, and masks the echo", async () => {
    const resolved: string[] = [];
    const registry = new ToolRegistry({ knownSecrets: () => [] });
    registry.register(
      buildSkillRunScriptTool(await installProbe(), { approvals: gate, approvalRequired: true, secrets: source(resolved) }),
    );
    const out = await registry.invoke(
      "skill.run_script",
      {
        skill: "probe",
        script: "probe.js",
        args: ["--key={{secret:DEMO_TOKEN}}"],
        env: [{ name: "DEMO_TOKEN", value: "{{secret:DEMO_TOKEN}}" }],
      },
      ctx(),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.category).toBe("shell_secret");
    expect(asked[0]!.preview).toContain("args: --key={{secret:DEMO_TOKEN}}");
    expect(asked[0]!.preview).toContain("env: DEMO_TOKEN={{secret:DEMO_TOKEN}}");
    expect(asked[0]!.reason).toContain("uses secret DEMO_TOKEN");
    expect(JSON.stringify(asked[0])).not.toContain(VALUE);
    expect(out.summary).toContain("arg=true env=true");
    expect(out.summary).not.toContain(VALUE);
    expect(resolved).toEqual(["DEMO_TOKEN"]);
  });

  it("fails an unknown secret, or an env name the skill did not declare, before any question", async () => {
    const resolved: string[] = [];
    const tool = buildSkillRunScriptTool(await installProbe(), {
      approvals: gate,
      approvalRequired: true,
      secrets: source(resolved),
    });
    await expect(
      tool.run({ skill: "probe", script: "probe.js", args: ["{{secret:OTHER}}"] }, ctx()),
    ).rejects.toThrow(/unknown secret OTHER/);
    await expect(
      tool.run(
        { skill: "probe", script: "probe.js", env: [{ name: "NODE_OPTIONS", value: "--require /tmp/x.js" }] },
        ctx(),
      ),
    ).rejects.toThrow(/not one of this skill's env_keys/);
    expect(asked).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("reads env as a list or a map, and only the declared names", () => {
    expect(parseScriptEnv([{ name: "A", value: "1" }], ["A"])).toEqual({ A: "1" });
    expect(parseScriptEnv({ A: "1" }, ["A"])).toEqual({ A: "1" });
    expect(parseScriptEnv(undefined, [])).toEqual({});
    expect(() => parseScriptEnv([{ name: "PATH", value: "/x" }], ["A"])).toThrow(/env_keys/);
    expect(() => parseScriptEnv([{ name: "A", value: 1 }], ["A"])).toThrow(/must be a string/);
  });
});
