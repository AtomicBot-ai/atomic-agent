/**
 * Lazy loader for `@lydell/node-pty` (ATO-2484), the pseudo-terminal
 * binding behind an interactive `os.shell.run` job (`tty: true`): a
 * real pty on macOS and Linux, ConPTY on Windows. It is the build of
 * Microsoft's node-pty that ships one prebuilt package per platform
 * (`@lydell/node-pty-<platform>-<arch>`), the same one Gemini CLI uses.
 *
 * Same deployment shape as `@napi-rs/keyring` (load-keyring.ts): the
 * package is an optional dependency, external in `scripts/bundle-sea.ts`,
 * `scripts/copy-node-pty-runtime.ts` ships it plus the host's prebuild
 * next to the SEA binary, and the load goes through CJS `createRequire`
 * anchored at the executable's directory.
 *
 * It never throws: a missing package, a platform without a prebuild or
 * a `.node` file the OS refuses to load all return `null`, and the shell
 * tool falls back to the system `script(1)` (macOS, Linux) or plain
 * pipes (tty-wrap.ts). The outcome is cached for the life of the
 * process, so a broken addon is probed once.
 *
 * Only the surface the shell job uses is typed here, so the agent does
 * not depend on the package's own declarations at compile time.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

export interface NodePtyDisposable {
  dispose(): void;
}

/** One running program on a pseudo-terminal. */
export interface NodePtyProcess {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  /** Everything the program prints (stdout and stderr share the terminal). */
  onData(listener: (data: string) => void): NodePtyDisposable;
  /** `signal` is a number on POSIX, `0`/absent on Windows. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
  /** Typed input, as keystrokes (`\r` is Enter). */
  write(data: string): void;
  resize(columns: number, rows: number): void;
  /** POSIX: the signal to send (default SIGHUP). Windows: ignored, the process is ended. */
  kill(signal?: string): void;
}

export interface NodePtySpawnOptions {
  /** The `TERM` the program sees (POSIX). */
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** UTF-8 by default. */
  encoding?: string | null;
}

export interface NodePtyModule {
  /**
   * `args` as a string is passed to Windows as the command line itself
   * (a `cmd.exe /d /s /c "…"` line built by the shell tool).
   */
  spawn(file: string, args: string[] | string, options: NodePtySpawnOptions): NodePtyProcess;
}

const bootRequire = createRequire(import.meta.url);

function isRunningUnderSea(): boolean {
  try {
    const sea: typeof import("node:sea") = bootRequire("node:sea");
    return sea.isSea();
  } catch {
    return false;
  }
}

let cached: NodePtyModule | null | undefined;

/** The pty binding, or `null` when it cannot be loaded on this machine. */
export function loadNodePty(): NodePtyModule | null {
  if (cached !== undefined) return cached;
  try {
    const req = isRunningUnderSea()
      ? createRequire(join(dirname(execPath), "__atomic_sea_anchor__.js"))
      : bootRequire;
    const mod = req("@lydell/node-pty") as Partial<NodePtyModule>;
    cached = typeof mod.spawn === "function" ? (mod as NodePtyModule) : null;
  } catch {
    cached = null;
  }
  return cached;
}
