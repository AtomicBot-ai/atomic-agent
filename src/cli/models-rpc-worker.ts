import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";
import { getConfig } from "../config/index.js";
import { resolveBackendDir } from "../local-llm/backend-paths.js";
import { DEFAULT_RPC_PORT } from "../local-llm/server/rpc-peers.js";

/**
 * `atomic-agent models rpc-worker` (ATO-2338): lend this computer's
 * memory and GPU to a model running on another one. Starts llama.cpp's
 * `rpc-server` in the foreground until Ctrl-C; the main computer lists
 * this one in `localModels.managed.rpcServers`.
 *
 * Loopback only unless `--lan`: llama.cpp RPC has no authentication, so
 * opening it to the network is the operator's explicit choice, with a
 * warning (as llama.cpp's own `rpc-server` prints).
 */
export interface RpcWorkerOptions {
  host: string;
  port: number;
  /** `-c`: rpc-server keeps received tensors in its local cache. */
  cache: boolean;
}

export function parseRpcWorkerArgs(args: readonly string[]): RpcWorkerOptions | { error: string } {
  let host = "127.0.0.1";
  let port = DEFAULT_RPC_PORT;
  let cache = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--lan") host = "0.0.0.0";
    else if (a === "--cache") cache = true;
    else if (a === "--host") {
      const v = args[++i];
      if (!v || !/^[0-9A-Fa-f:.]+$/.test(v)) return { error: "--host needs an IP address of this computer" };
      host = v;
    } else if (a === "--port") {
      const v = args[++i] ?? "";
      const n = Number(v);
      if (!/^\d{1,5}$/.test(v) || n < 1 || n > 65535) return { error: "--port needs a number 1..65535" };
      port = n;
    } else return { error: `unknown option ${a}` };
  }
  return { host, port, cache };
}

/**
 * Where `rpc-server` is: `ATOMIC_AGENT_RPC_SERVER`, then next to the
 * managed llama-server, then on PATH. `null` when none of them has it.
 */
export function resolveRpcServerBinary(deps: {
  env: NodeJS.ProcessEnv;
  backendDir: string;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}): string | null {
  const name = deps.platform === "win32" ? "rpc-server.exe" : "rpc-server";
  const override = deps.env.ATOMIC_AGENT_RPC_SERVER?.trim();
  if (override) return deps.exists(override) ? override : null;
  const candidates = [
    join(deps.backendDir, name),
    ...(deps.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
  ];
  return candidates.find((p) => deps.exists(p)) ?? null;
}

/** This computer's LAN IPv4 addresses, for the line to paste on the main one. */
export function lanAddresses(nets: ReturnType<typeof networkInterfaces>): string[] {
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

export const RPC_LAN_WARNING =
  "warning: llama.cpp RPC has no password or encryption. Anyone on this network can use this computer's " +
  "GPU through this port. Run it only on a home or office network you trust, and stop it with Ctrl-C when done.\n";

export const RPC_SERVER_MISSING =
  "rpc-server not found. It ships with llama.cpp builds made with GGML_RPC=ON; the bundled engine does not " +
  "include it yet. Install such a build (or set ATOMIC_AGENT_RPC_SERVER to its rpc-server) and run this again.\n";

export interface RpcWorkerDeps {
  spawn?: typeof nodeSpawn;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  binary?: string | null;
  addresses?: string[];
}

export async function runModelsRpcWorker(args: readonly string[], deps: RpcWorkerDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const opts = parseRpcWorkerArgs(args);
  if ("error" in opts) {
    err(`models rpc-worker: ${opts.error}\nusage: atomic-agent models rpc-worker [--lan | --host <ip>] [--port <n>] [--cache]\n`);
    return 1;
  }
  const binary =
    deps.binary !== undefined
      ? deps.binary
      : resolveRpcServerBinary({
          env: process.env,
          backendDir: resolveBackendDir(getConfig().paths.localModelsDataDir),
          platform: process.platform,
          exists: existsSync,
        });
  if (!binary) {
    err(RPC_SERVER_MISSING);
    return 1;
  }
  const loopback = opts.host === "127.0.0.1" || opts.host === "::1";
  if (!loopback) err(RPC_LAN_WARNING);
  const addresses = loopback ? ["127.0.0.1"] : (deps.addresses ?? lanAddresses(networkInterfaces()));
  const first = `${addresses[0] ?? "<this-computer-ip>"}:${opts.port}`;
  out(
    `rpc-worker: lending this computer on ${opts.host}:${opts.port} (Ctrl-C to stop)\n` +
      `on the main computer: atomic-agent config set localModels.managed.rpcServers '["${first}"]'` +
      `, then atomic-agent models stop && atomic-agent models start\n` +
      (addresses.length > 1 ? `this computer's addresses: ${addresses.join(", ")}\n` : ""),
  );
  const argv = ["--host", opts.host, "--port", String(opts.port), ...(opts.cache ? ["-c"] : [])];
  const child = (deps.spawn ?? nodeSpawn)(binary, argv, { stdio: "inherit" });
  return await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      err(`models rpc-worker: could not start ${binary}: ${e.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal === "SIGINT" || signal === "SIGTERM" ? 0 : (code ?? 1)));
  });
}
