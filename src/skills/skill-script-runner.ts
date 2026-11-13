import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { buildCommandEnv, KNOWN_SECRET_ENV_VARS } from "../sandbox/command-env.js";
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
  /** Revalidate live workspace policy after asynchronous file checks, before spawn. */
  beforeRun?: (scriptPath: string) => void;
  /**
   * `tools.shell.envPassthrough`: secret-looking names the script still
   * inherits. Everything else secret-looking is stripped from its
   * environment, exactly as for `os.shell.run` (`buildCommandEnv`,
   * ATO-347). Omitted means none.
   */
  envPassthrough?: readonly string[];
}

const AGENT_CREDENTIALS = new Set(KNOWN_SECRET_ENV_VARS.map((name) => name.toUpperCase()));

/**
 * The `env_keys` a skill declared that its scripts may receive. The
 * agent's own provider keys and bot tokens (`KNOWN_SECRET_ENV_VARS`) are
 * never among them: a skill asks for its own service key, not for the
 * credentials the agent runs on.
 */
export function skillEnvKeys(skill: Pick<SkillRecord, "manifest">): string[] {
  return (skill.manifest.envKeys ?? []).filter(
    (name) => !AGENT_CREDENTIALS.has(name.toUpperCase()),
  );
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
 *
 * The script gets the same filtered environment as a shell command: a
 * skill is third-party code the model chose to run, so it must not
 * inherit the provider keys and bot tokens `.env` loaded into the
 * agent's own process (ATO-877). The one addition is the skill's own
 * `env_keys` (see `skillEnvKeys`).
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
  let windowsVerbatimArguments = false;
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
    windowsVerbatimArguments = inv.windowsVerbatimArguments;
  } else {
    cmd = scriptPath;
    args = userArgs;
  }

  let result: CommandResult;
  try {
    params.beforeRun?.(scriptPath);
    result = await runCommand(cmd, args, {
      cwd: skill.rootDir,
      // Built per call from the live env, so a key added mid-session is
      // filtered the same way.
      // plus the names this skill declared in `env_keys`, for its own
      // scripts only (never another skill's, never `os.shell.run`).
      env: buildCommandEnv(process.env, [
        ...(params.envPassthrough ?? []),
        ...skillEnvKeys(skill),
      ]),
      timeoutMs: params.timeoutMs ?? 30_000,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
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
