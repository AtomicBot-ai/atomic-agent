import { spawn } from "node:child_process";

import { windowsPowerShellPath } from "../update/run-app-update.js";

export interface RemovePathEntryResult {
  /** The user `Path` with the entry taken out; `current` when unchanged. */
  readonly value: string;
  readonly changed: boolean;
}

/**
 * Take `dir` back out of a Windows user `Path` value.
 *
 * `install.ps1` appends the install dir with a `;` separator, and treats
 * an entry as already present when it matches ignoring case and trailing
 * backslashes. This removes exactly the entries that test would have
 * called a match and leaves every other entry — its spelling, its order,
 * any empty slots the operator's own tools left — byte for byte. A
 * `Path` that is only ever edited by exact-entry match cannot lose
 * something that belonged to somebody else.
 */
export function removeUserPathEntry(
  current: string,
  dir: string,
): RemovePathEntryResult {
  const target = normalizeEntry(dir);
  if (target.length === 0) return { value: current, changed: false };
  const entries = current.split(";");
  const kept = entries.filter((entry) => normalizeEntry(entry) !== target);
  if (kept.length === entries.length) return { value: current, changed: false };
  return { value: kept.join(";"), changed: true };
}

function normalizeEntry(entry: string): string {
  return entry.replace(/\\+$/, "").toLowerCase();
}

/**
 * Reads and writes the `HKCU\Environment` `Path` the way `install.ps1`
 * does, through `[Environment]::…('Path', …, 'User')`, so the uninstall
 * edits the same value with the same API that wrote it. Injected so the
 * edit is testable on a machine with no registry.
 */
export interface UserPathStore {
  /** The current user `Path`, or `null` when it is unset. */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export type PowerShellRunner = (
  script: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

/**
 * The value travels as base64 of its UTF-8 bytes in both directions:
 * PowerShell's redirected stdout uses the console code page, and a
 * non-ASCII directory elsewhere in `Path` that came back mangled would be
 * written back mangled. Going in, it rides an env var rather than the
 * command line so no quoting rule ever sees it.
 */
const VALUE_ENV = "ATOMIC_AGENT_USER_PATH_B64";

const READ_SCRIPT =
  "$v = [Environment]::GetEnvironmentVariable('Path', 'User'); " +
  "if ($null -eq $v) { [Console]::Out.Write('-') } " +
  "else { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))) }";

const WRITE_SCRIPT =
  "[Environment]::SetEnvironmentVariable('Path', " +
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${VALUE_ENV})), 'User')`;

export function createUserPathStore(
  runPowerShell: PowerShellRunner = defaultRunPowerShell,
): UserPathStore {
  return {
    async read() {
      const out = (await runPowerShell(READ_SCRIPT, process.env)).trim();
      if (out === "-") return null;
      return Buffer.from(out, "base64").toString("utf8");
    },
    async write(value) {
      await runPowerShell(WRITE_SCRIPT, {
        ...process.env,
        [VALUE_ENV]: Buffer.from(value, "utf8").toString("base64"),
      });
    },
  };
}

function defaultRunPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      windowsPowerShellPath(env),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `powershell exited with ${code}`));
    });
  });
}
