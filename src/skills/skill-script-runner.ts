import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { runCommand, type CommandResult } from "../sandbox/command-runner.js";
import {
  buildSubshellInvocation,
  quoteCmdArg,
} from "../sandbox/shell-invocation.js";
import type { SkillRecord } from "./skill-loader.js";

export interface RunSkillScriptParams {
  script: string;
  args?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SkillScriptOutcome extends CommandResult {
  skill: string;
  script: string;
  scriptPath: string;
}

export class SkillScriptError extends Error {
  constructor(
    message: string,
    public readonly code: "not_allowed" | "not_found" | "not_executable",
  ) {
    super(message);
    this.name = "SkillScriptError";
  }
}

/**
 * Execute a skill-owned script. The script must be declared in the
 * skill's `requires_scripts` frontmatter entry and must live inside the
 * skill's `scripts/` directory — we resolve relative to the skill root
 * and reject any path that escapes it. `.ts`/`.js` are run with the current
 * Node binary, `.sh` with `bash`, `.ps1` with PowerShell, `.cmd`/`.bat`
 * through the Windows subshell, anything else is run directly (so a `#!`
 * shebang on an executable file also works).
 */
export async function runSkillScript(
  skill: SkillRecord,
  params: RunSkillScriptParams,
): Promise<SkillScriptOutcome> {
  const requested = params.script;
  if (!skill.manifest.requiresScripts.includes(requested)) {
    throw new SkillScriptError(
      `skill "${skill.manifest.name}" does not declare script "${requested}" in requires_scripts`,
      "not_allowed",
    );
  }

  const scriptsRoot = resolve(skill.rootDir, "scripts");
  const scriptPath = resolve(scriptsRoot, requested);
  // Cross-platform containment check: `startsWith(root + "/")` breaks on
  // Windows where the separator is `\`. `relative()` yields `..`-prefixed or
  // absolute output when the target escapes the root.
  const rel = relative(scriptsRoot, scriptPath);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new SkillScriptError(
      `script path escapes the skill scripts/ directory: ${requested}`,
      "not_allowed",
    );
  }

  const info = await stat(scriptPath).catch(() => null);
  if (!info?.isFile()) {
    throw new SkillScriptError(
      `script file not found: ${scriptPath}`,
      "not_found",
    );
  }

  const ext = extname(scriptPath).toLowerCase();
  let cmd: string;
  let args: string[];
  const userArgs = params.args ?? [];
  if (ext === ".ts") {
    cmd = process.execPath;
    args = ["--experimental-strip-types", scriptPath, ...userArgs];
  } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    cmd = process.execPath;
    args = [scriptPath, ...userArgs];
  } else if (ext === ".sh") {
    cmd = "bash";
    args = [scriptPath, ...userArgs];
  } else if (ext === ".ps1") {
    cmd = "powershell.exe";
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...userArgs,
    ];
  } else if (ext === ".cmd" || ext === ".bat") {
    // Batch scripts cannot be spawned directly; route through the subshell.
    const line = [scriptPath, ...userArgs].map(quoteCmdArg).join(" ");
    const inv = buildSubshellInvocation(line);
    cmd = inv.command;
    args = inv.args;
  } else {
    cmd = scriptPath;
    args = userArgs;
  }

  let result: CommandResult;
  try {
    result = await runCommand(cmd, args, {
      cwd: skill.rootDir,
      timeoutMs: params.timeoutMs ?? 30_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new SkillScriptError(
        `interpreter for "${requested}" not found (tried "${cmd}"); ensure it is installed and on PATH`,
        "not_executable",
      );
    }
    throw err;
  }

  return {
    ...result,
    skill: skill.manifest.name,
    script: requested,
    scriptPath,
  };
}
