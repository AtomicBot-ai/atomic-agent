import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";

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

/**
 * Whether the running process is the installed SEA binary (and thus a
 * self-update over `process.execPath` is meaningful). Returns `false`
 * when running under `node` / `tsx` in development — overwriting the
 * Node binary with the agent installer would be destructive.
 */
export function canSelfUpdate(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  // `node` / `node.exe` (and the rare `tsx` shim) are dev runtimes.
  if (exe.startsWith("node") || exe.startsWith("tsx")) return false;
  return exe.startsWith("atomic-agent");
}

/**
 * Re-run the canonical `install.sh` from GitHub, targeting the directory
 * of the currently-running binary so the existing install is upgraded
 * in place. The installer already handles platform detection, checksum
 * verification and extraction; we only pin the install dir and suppress
 * the rc-file PATH edit (the entry is already present on an upgrade).
 *
 * Only valid for the installed SEA binary — see {@link canSelfUpdate}.
 * The running process is **not** restarted; the caller must prompt the
 * user to relaunch so the new binary takes effect.
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
  if (process.platform === "win32") {
    throw new AppUpdateError(
      "in-app update is not supported on Windows; download the latest " +
        "release zip from GitHub Releases",
    );
  }

  const repo = opts?.repo ?? "AtomicBot-ai/atomic-agent";
  const installDir = dirname(process.execPath);
  const scriptUrl = `https://raw.githubusercontent.com/${repo}/main/scripts/install.sh`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATOMIC_AGENT_REPO: repo,
    ATOMIC_AGENT_INSTALL_DIR: installDir,
    // The PATH entry already exists on an upgrade; don't touch rc files.
    ATOMIC_AGENT_NO_PATH: "1",
    ...(opts?.version ? { ATOMIC_AGENT_VERSION: opts.version } : {}),
  };

  // `curl ... | sh` mirrors the documented install path exactly so the
  // updater never drifts from the canonical installer.
  const command = `curl -fsSL ${scriptUrl} | sh`;

  await runShell(command, env, opts?.onLine, opts?.signal);
  return { ok: true, installDir };
}

function runShell(
  command: string,
  env: NodeJS.ProcessEnv,
  onLine: ((line: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", ["-c", command], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });

    const emit = (chunk: Buffer): void => {
      if (!onLine) return;
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) onLine(trimmed);
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
      reject(
        new AppUpdateError(
          `install script exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}
