import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * How the desktop starts its agent: `atag serve` on loopback, on a free
 * port, with a fresh API key per launch.
 *
 * The key goes to the child on its stdin (`--api-key-stdin`, ATO-2538):
 * one line, then the pipe is closed. It is in neither of the two places
 * other programs can read a process from:
 * - the command line, which every program on the machine can read
 *   (`ps`, Task Manager, `/proc/<pid>/cmdline`), ATO-1705;
 * - the environment, which every program of the same user can read even
 *   after the child unsets the variable (`/proc/<pid>/environ` on Linux,
 *   `ps eww` on macOS), the agent's own shell commands included.
 * `docker login --password-stdin` takes its secret the same way. Any
 * `ATOMIC_AGENT_API_KEY` the desktop itself was started with is dropped
 * from the child's environment, so no stale key travels along either.
 * An `atag` older than the flag refuses it and exits, rather than running
 * with a key in its environment.
 */

/** The variable `atag serve` would otherwise read its key from. Never set for the desktop's child. */
export const SERVE_API_KEY_ENV = "ATOMIC_AGENT_API_KEY";

/** The flag that makes `atag serve` read its key from the first line of stdin. */
export const SERVE_API_KEY_STDIN_FLAG = "--api-key-stdin";

/** stdin a pipe (the key), stdout and stderr pipes (the log relay). */
export const SERVE_STDIO: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

/** `atag serve`'s arguments: loopback, `port`, the stdin key flag, then the platform's watch arguments. No key. */
export function serveSpawnArgs(port: number, watchArgs: readonly string[]): string[] {
  return ["serve", "--host", "127.0.0.1", "--port", String(port), SERVE_API_KEY_STDIN_FLAG, ...watchArgs];
}

/** `base` (the agent environment) without any API key in it. `base` is not changed. */
export function serveSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env[SERVE_API_KEY_ENV];
  return env;
}

/**
 * The options agent-client.ts spawns `atag serve` with, all but `cwd`: the
 * environment from `base` without a key, stdin a pipe for the key, and no
 * console window on Windows. The test starts its stand-in child with these
 * same options, so a key added back here fails it.
 */
export function serveSpawnOptions(base: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: boolean;
} {
  return { env: serveSpawnEnv(base), stdio: SERVE_STDIO, windowsHide: true };
}

/**
 * Hand `token` to the child: one line on its stdin, then end the pipe so
 * nothing else can be read from it. A child that already died leaves an
 * EPIPE here; that is swallowed, its exit is reported on its own.
 */
export function sendServeKey(stdin: Writable | null, token: string): void {
  if (!stdin) return;
  stdin.once("error", () => undefined);
  stdin.end(`${token}\n`);
}

/** What `startServe` needs to start one `atag serve`. */
export interface ServeLaunch {
  binary: string;
  port: number;
  /** The platform's watch arguments (`serveWatchArgs`). */
  watchArgs: readonly string[];
  cwd: string;
  /** The agent environment; any key in it is dropped. */
  env: NodeJS.ProcessEnv;
  /** This launch's API key, sent on stdin only. */
  token: string;
  /** Put before serve's own arguments. Only the test sets it, to run a stand-in program (`-e <script> --`). */
  leadingArgs?: readonly string[];
}

/**
 * Start `atag serve` and hand it its key: the one place the desktop does
 * this (agent-client.ts). The test starts its stand-in child through this
 * same function, so a key put back on the command line or in the
 * environment here fails it.
 */
export function startServe(l: ServeLaunch): ChildProcess {
  const child = spawn(l.binary, [...(l.leadingArgs ?? []), ...serveSpawnArgs(l.port, l.watchArgs)], {
    cwd: l.cwd,
    ...serveSpawnOptions(l.env),
  });
  sendServeKey(child.stdin, l.token);
  return child;
}
