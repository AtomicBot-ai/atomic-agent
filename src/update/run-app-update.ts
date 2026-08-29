import { spawn } from "node:child_process";
import { dirname, posix as pathPosix, win32 as pathWin32 } from "node:path";

export interface RunAppUpdateOptions {
  repo?: string;
  /** Optional tag to pin (e.g. `v0.1.40`); omit for latest. */
  version?: string;
  /** Streamed install-script output, one trimmed line at a time. */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunAppUpdateResult {
  ok: boolean;
  installDir: string;
}

export class AppUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppUpdateError";
  }
}

const DEFAULT_REPO = "AtomicBot-ai/atomic-agent";

/**
 * How many trailing installer lines travel with a failure. The installers put
 * the reason last (`error: ...` on Windows, a bare stderr line on POSIX), so a
 * short tail is enough to explain a 404, a checksum mismatch or a locked file.
 */
const FAILURE_TAIL_LINES = 8;

/**
 * Compose the failure message for a non-zero installer exit. The exit code on
 * its own is not actionable, and the streamed `onLine` output lands in the
 * runtime feed rather than next to the failed-update notice — so the reason has
 * to be attached to the error itself. Pure, so the formatting is unit-testable.
 */
export function formatInstallFailure(
  code: number | null,
  tail: readonly string[],
): string {
  const header = `install script exited with code ${code ?? "unknown"}`;
  if (tail.length === 0) return `${header} (no output)`;
  return [header, ...tail.map((line) => `  ${line}`)].join("\n");
}

/**
 * Whether the running process is the installed SEA binary (and thus a
 * self-update over `process.execPath` is meaningful). Returns `false`
 * when running under `node` / `tsx` in development — overwriting the
 * Node binary with the agent installer would be destructive.
 *
 * Supported on all platforms. On Windows the installer (`install.ps1`)
 * applies the new tree as an all-or-nothing transaction: every existing
 * file — including the locked, running `atomic-agent.exe` and the loaded
 * `better_sqlite3.node` — is displaced to `<name>.old-<stamp>` before its
 * replacement is written, so a mid-run failure rolls back instead of
 * leaving a half-updated install. The update completes while the process
 * is live; the user relaunches to pick up the new binary.
 */
export function canSelfUpdate(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): boolean {
  const base =
    platform === "win32"
      ? pathWin32.basename(execPath)
      : pathPosix.basename(execPath);
  const exe = base.toLowerCase();
  // `node` / `node.exe` (and the rare `tsx` shim) are dev runtimes.
  if (exe.startsWith("node") || exe.startsWith("tsx")) return false;
  return exe.startsWith("atomic-agent");
}

export interface UpdateInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Absolute path to the system Windows PowerShell, falling back to a bare
 * `powershell.exe` when %SystemRoot% is not set.
 *
 * A bare name is resolved against the inherited PATH, which is the user's,
 * not ours. When that PATH puts a trimmed, relocated or 2.0-engine shell
 * first, the installer loses the Utility/Archive modules and dies on
 * "'Get-FileHash' is not recognized" — while the very same update run from
 * `cmd` succeeds, because there the name resolves to the system copy
 * (issue #174). Naming the system copy outright removes that variance;
 * install.ps1 no longer depends on those modules either, so the two fixes
 * are belt and braces.
 */
function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot;
  if (!systemRoot) return "powershell.exe";
  return pathWin32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Build the platform-specific process invocation that re-runs the
 * canonical installer against the current install dir. Pure — no I/O —
 * so it is unit-testable without spawning anything.
 *
 * - POSIX: `sh -c "curl -fsSL .../install.sh | sh"`.
 * - Windows: `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
 *   -Command "irm .../install.ps1 | iex"` — see {@link windowsPowerShellPath}.
 *
 * Both pin the install dir to the running binary's directory and
 * suppress the PATH edit (already present on an upgrade). The installer
 * itself handles checksum verification, extraction, and — on Windows —
 * the locked-file swap that makes in-place self-update possible.
 */
export function buildUpdateInvocation(params: {
  platform: NodeJS.Platform;
  repo: string;
  installDir: string;
  version?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): UpdateInvocation {
  const { platform, repo, installDir, version } = params;
  const baseEnv = params.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ATOMIC_AGENT_REPO: repo,
    ATOMIC_AGENT_INSTALL_DIR: installDir,
    // The PATH entry already exists on an upgrade; don't touch it.
    ATOMIC_AGENT_NO_PATH: "1",
    ...(version ? { ATOMIC_AGENT_VERSION: version } : {}),
  };

  if (platform === "win32") {
    const scriptUrl = `https://raw.githubusercontent.com/${repo}/main/scripts/install.ps1`;
    return {
      command: windowsPowerShellPath(baseEnv),
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `irm '${scriptUrl}' | iex`,
      ],
      env,
    };
  }

  const scriptUrl = `https://raw.githubusercontent.com/${repo}/main/scripts/install.sh`;
  // `curl ... | sh` mirrors the documented install path exactly so the
  // updater never drifts from the canonical installer.
  return { command: "sh", args: ["-c", `curl -fsSL ${scriptUrl} | sh`], env };
}

/**
 * Re-run the canonical installer from GitHub, targeting the directory of
 * the currently-running binary so the existing install is upgraded in
 * place. Only valid for the installed SEA binary — see
 * {@link canSelfUpdate}. The running process is **not** restarted; the
 * caller must prompt the user to relaunch so the new binary takes effect.
 */
export async function runAppUpdate(
  opts?: RunAppUpdateOptions,
): Promise<RunAppUpdateResult> {
  if (!canSelfUpdate()) {
    throw new AppUpdateError(
      "self-update is only supported for the installed binary; " +
        "update via your package manager or git checkout in development",
    );
  }

  const repo = opts?.repo ?? DEFAULT_REPO;
  const installDir = dirname(process.execPath);
  const invocation = buildUpdateInvocation({
    platform: process.platform,
    repo,
    installDir,
    ...(opts?.version ? { version: opts.version } : {}),
  });

  await runProcess(invocation, opts?.onLine, opts?.signal);
  return { ok: true, installDir };
}

function runProcess(
  invocation: UpdateInvocation,
  onLine: ((line: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });

    const tail: string[] = [];
    const emit = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        onLine?.(trimmed);
        tail.push(trimmed);
        if (tail.length > FAILURE_TAIL_LINES) tail.shift();
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);

    child.on("error", (err) => {
      reject(new AppUpdateError(`install script failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new AppUpdateError(formatInstallFailure(code, tail)));
    });
  });
}
