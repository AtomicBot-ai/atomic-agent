import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkillScript, SkillScriptError } from "./skill-script-runner.js";
import type { SkillRecord } from "./skill-loader.js";

async function makeSkill(
  root: string,
  opts: { requiresScripts?: string[] } = {},
): Promise<SkillRecord> {
  await mkdir(join(root, "scripts"), { recursive: true });
  const manifest = {
    name: "echo-skill",
    description: "echoes args",
    version: "0.1.0",
    requiresTools: [],
    requiresScripts: opts.requiresScripts ?? ["echo.js"],
    dangerous: false,
  };
  const manifestPath = join(root, "SKILL.md");
  await writeFile(
    manifestPath,
    [
      "---",
      `name: ${manifest.name}`,
      `description: "${manifest.description}"`,
      `version: ${manifest.version}`,
      `requires_scripts: [${manifest.requiresScripts.join(", ")}]`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    manifest,
    rootDir: root,
    manifestPath,
    source: "global",
  };
}

describe("runSkillScript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-skill-run-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs an allowed node script and captures stdout", async () => {
    const skill = await makeSkill(dir);
    await writeFile(
      join(dir, "scripts", "echo.js"),
      "process.stdout.write('hello ' + process.argv.slice(2).join(' '));",
      "utf8",
    );
    const result = await runSkillScript(skill, {
      script: "echo.js",
      args: ["magos"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello magos");
    expect(result.skill).toBe("echo-skill");
  });

  it("rejects scripts not listed in requires_scripts", async () => {
    const skill = await makeSkill(dir, { requiresScripts: ["other.js"] });
    await writeFile(
      join(dir, "scripts", "malicious.js"),
      "process.exit(0)",
      "utf8",
    );
    await expect(
      runSkillScript(skill, { script: "malicious.js" }),
    ).rejects.toBeInstanceOf(SkillScriptError);
  });

  it("rejects path traversal attempts", async () => {
    const skill = await makeSkill(dir, { requiresScripts: ["../outside.js"] });
    await writeFile(join(dir, "outside.js"), "process.exit(0)", "utf8");
    await expect(
      runSkillScript(skill, { script: "../outside.js" }),
    ).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("runs a bash script by .sh extension", async () => {
    const skill = await makeSkill(dir, { requiresScripts: ["run.sh"] });
    const scriptPath = join(dir, "scripts", "run.sh");
    await writeFile(scriptPath, "#!/usr/bin/env bash\necho hi-bash\n", "utf8");
    await chmod(scriptPath, 0o755);
    const result = await runSkillScript(skill, {
      script: "run.sh",
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi-bash");
  });

  describe("the script's environment (ATO-877)", () => {
    // A skill script is third-party code: it gets the shell's filtered
    // environment, not the agent's own keys.
    const NAMES = {
      OPENROUTER_API_KEY: "ato877-openrouter-key",
      ATO877_PASS_TOKEN: "ato877-passed-token",
      ATO877_PLAIN: "ato877-plain",
    } as const;
    const previous = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const [name, value] of Object.entries(NAMES)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
    });

    afterEach(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      previous.clear();
    });

    async function printEnv(envPassthrough?: readonly string[]) {
      const skill = await makeSkill(dir, { requiresScripts: ["env.js"] });
      await writeFile(
        join(dir, "scripts", "env.js"),
        "process.stdout.write(JSON.stringify({" +
          "key: process.env.OPENROUTER_API_KEY ?? null," +
          "pass: process.env.ATO877_PASS_TOKEN ?? null," +
          "plain: process.env.ATO877_PLAIN ?? null}));",
        "utf8",
      );
      const result = await runSkillScript(skill, {
        script: "env.js",
        timeoutMs: 5000,
        ...(envPassthrough !== undefined ? { envPassthrough } : {}),
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout) as Record<string, string | null>;
    }

    it("does not hand the script a provider key, and keeps ordinary variables", async () => {
      expect(await printEnv()).toEqual({
        key: null,
        pass: null,
        plain: "ato877-plain",
      });
      // The agent's own environment is untouched.
      expect(process.env.OPENROUTER_API_KEY).toBe("ato877-openrouter-key");
    });

    it("passes a name listed in envPassthrough, and only that one", async () => {
      expect(await printEnv(["ATO877_PASS_TOKEN"])).toEqual({
        key: null,
        pass: "ato877-passed-token",
        plain: "ato877-plain",
      });
    });
  });
});
