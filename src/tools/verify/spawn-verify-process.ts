/**
 * The child process a `command` or `service` run owns.
 *
 * Spawned `detached` so it leads its own process group, and the whole
 * group is killed with SIGKILL when the run ends — on timeout, on abort,
 * and when the command itself finishes, because a test script that
 * leaves a server behind must not leave it behind in our process tree.
 *
 * `network: false` is a soft block: `HTTP_PROXY` / `HTTPS_PROXY` /
 * `ALL_PROXY` point at an unreachable local port and `NO_PROXY` is
 * emptied, which stops every proxy-honouring client (curl, npm, pip,
 * fetch under undici's env proxy, most SDKs). It is not a sandbox: a
 * raw socket ignores it.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { killProcessTree } from "../../sandbox/kill-process-tree.js";
import { buildSubshellInvocation } from "../../sandbox/shell-invocation.js";
import { needsShellInterpretation } from "../os/shell.js";

export const OUTPUT_TAIL_CHARS = 8_000;
/** Kept for `stdout contains` checks; past this the head is dropped. */
const OUTPUT_KEEP_CHARS = 1024 * 1024;

export class TailBuffer {
  private text = "";
  private dropped = false;

  append(chunk: Buffer | string): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.text.length > OUTPUT_KEEP_CHARS) {
      this.text = this.text.slice(-OUTPUT_KEEP_CHARS);
      this.dropped = true;
    }
  }

  /** Everything kept (up to 1 MB, head dropped first). */
  all(): string {
    return this.text;
  }

  /** The last 8,000 chars — tail first, that is where the failure is. */
  tail(): string {
    const clipped = this.text.length > OUTPUT_TAIL_CHARS || this.dropped;
    const tail = this.text.slice(-OUTPUT_TAIL_CHARS);
    return clipped ? `…${tail}` : tail;
  }
}

export const NETWORK_BLOCK_PROXY = "http://127.0.0.1:9";

export function networkBlockEnv(): Record<string, string> {
  return {
    HTTP_PROXY: NETWORK_BLOCK_PROXY,
    HTTPS_PROXY: NETWORK_BLOCK_PROXY,
    ALL_PROXY: NETWORK_BLOCK_PROXY,
    http_proxy: NETWORK_BLOCK_PROXY,
    https_proxy: NETWORK_BLOCK_PROXY,
    all_proxy: NETWORK_BLOCK_PROXY,
    NO_PROXY: "",
    no_proxy: "",
  };
}

export interface SpawnVerifyOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  network: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VerifyProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** `spawn` itself failed (ENOENT and friends). */
  readonly spawnError?: string;
}

export interface VerifyProcess {
  readonly child: ChildProcess;
  readonly commandLine: string;
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  readonly exited: Promise<VerifyProcessExit>;
  /** SIGKILL the whole process group; idempotent. */
  killGroup(): void;
}

/** The argv actually spawned: direct, or through the OS subshell for a command line. */
export function resolveInvocation(
  cmd: string,
  args: readonly string[],
): { command: string; args: string[]; commandLine: string } {
  const commandLine = [cmd, ...args].join(" ");
  if (needsShellInterpretation(cmd, args)) {
    const shell = buildSubshellInvocation(commandLine);
    return { command: shell.command, args: shell.args, commandLine };
  }
  return { command: cmd, args: [...args], commandLine };
}

export function spawnVerifyProcess(
  cmd: string,
  args: readonly string[],
  options: SpawnVerifyOptions,
): VerifyProcess {
  const invocation = resolveInvocation(cmd, args);
  const detached = process.platform !== "win32";
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.network ? {} : networkBlockEnv()),
      ...(options.env ?? {}),
    },
    detached,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = new TailBuffer();
  const stderr = new TailBuffer();
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let killed = false;
  let timedOut = false;
  let aborted = false;
  const killGroup = (): void => {
    if (killed) return;
    killed = true;
    if (detached && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Group already gone, or not a leader after all — fall through.
      }
    }
    killProcessTree(child, { force: true });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killGroup();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const exited = new Promise<VerifyProcessExit>((resolve) => {
    let settled = false;
    const finish = (exit: VerifyProcessExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Whatever the command left running in its group dies with it.
      killGroup();
      resolve(exit);
    };
    child.on("error", (err) => {
      finish({ exitCode: null, signal: null, timedOut, aborted, spawnError: err.message });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, timedOut, aborted });
    });
  });

  return { child, commandLine: invocation.commandLine, stdout, stderr, exited, killGroup };
}
