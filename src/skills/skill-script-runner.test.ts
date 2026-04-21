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
});
