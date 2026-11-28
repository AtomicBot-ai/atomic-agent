/** Shared fakes for the `atag launch` tests (launch-command*.test.ts). */
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";

import { launchCommand, type LaunchCommandDeps } from "./launch-command.js";
import type { LaunchServe } from "./launch-serve.js";

export const SERVE: LaunchServe = { baseUrl: "http://127.0.0.1:41234", port: 41234, started: false };

export function fakeSpawn(exitCode: number | null, signal: NodeJS.Signals | null = null) {
  const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawn = ((cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    setImmediate(() => child.emit("exit", exitCode, signal));
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

export async function run(args: string[], over: LaunchCommandDeps = {}) {
  let out = "";
  let err = "";
  const deps: LaunchCommandDeps = {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    stateDir: () => "/state",
    cwd: () => "/work",
    env: { PATH: "/bin" },
    findBinary: (b) => `/usr/local/bin/${b}`,
    resolveKey: () => ({ key: "the-serve-key" }),
    issueToken: () => ({ token: "the-run-token", revoke: () => {} }),
    lastingToken: () => ({ token: "the-lasting-token" }),
    findServe: async () => SERVE,
    checkKey: async () => true,
    probeLocal: async () => ({ ok: true, modelId: "qwen-local" }),
    platform: "darwin",
    ...over,
  };
  const code = await launchCommand(args, deps);
  return { code, out, err };
}
