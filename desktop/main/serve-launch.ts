/**
 * How the desktop starts its agent: `atag serve` on loopback, on a free
 * port, with a fresh API key per launch (ATO-1705).
 *
 * The key goes in the child's environment (`ATOMIC_AGENT_API_KEY`), never
 * on its command line. A command line is readable by every program on the
 * machine (`ps`, Task Manager, `/proc/<pid>/cmdline`); a process's
 * environment only by its own user (on Linux `/proc/<pid>/environ` is
 * owner-only). Serve reads the variable, then removes it from its own
 * environment so nothing it starts inherits it. Jupyter takes its token
 * the same way (`JUPYTER_TOKEN`). Every `atag` the desktop can start
 * reads `ATOMIC_AGENT_API_KEY` when `--api-key` is not given.
 */

/** The variable `atag serve` reads its key from when no `--api-key` is given. */
export const SERVE_API_KEY_ENV = "ATOMIC_AGENT_API_KEY";

/**
 * `atag serve`'s arguments: `host` (loopback unless Settings › Connections ›
 * Connect phone lets phones on this Wi-Fi in, ATO-2493 phone-access.ts),
 * `port`, then the platform's watch arguments. No key.
 */
export function serveSpawnArgs(port: number, watchArgs: readonly string[], host = "127.0.0.1"): string[] {
  return ["serve", "--host", host, "--port", String(port), ...watchArgs];
}

/** `base` (the agent environment) with the per-launch key added. `base` is not changed. */
export function serveSpawnEnv(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...base, [SERVE_API_KEY_ENV]: token };
}
