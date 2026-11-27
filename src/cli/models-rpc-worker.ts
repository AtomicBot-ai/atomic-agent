import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { getConfig } from "../config/index.js";
import { resolveBackendDir } from "../local-llm/backend-paths.js";
import { coreBackendSpawn, type CoreBackendSpawn } from "../local-llm/core/core-backend-env.js";
import { readCoreBackend } from "../local-llm/core/core-state.js";
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
 * agent's own llama-server (`<data>/local-models/backend`), then next to
 * the llama-server Atomic Core installed (the default engine, ATO-2454),
 * then on PATH. `null` when none of them has it. Both engines unpack the
 * same TurboQuant archive, which carries `rpc-server` beside
 * `llama-server` once it is built with GGML_RPC=ON.
 *
 * Paths and the PATH separator follow `platform`, not the host, so the
 * Windows lookup (`rpc-server.exe`, `;`, any case of `Path`) is the same
 * code a Windows run takes.
 */
export function resolveRpcServerBinary(deps: {
  env: NodeJS.ProcessEnv;
  backendDir: string;
  /** Folder of Core's active llama-server, `null` when Core has none installed. */
  coreBackendDir?: string | null;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}): string | null {
  const win = deps.platform === "win32";
  const path = win ? win32 : posix;
  const name = win ? "rpc-server.exe" : "rpc-server";
  const override = deps.env.ATOMIC_AGENT_RPC_SERVER?.trim();
  if (override) return deps.exists(override) ? override : null;
  const pathKey = win ? Object.keys(deps.env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const searchPath = (pathKey ? deps.env[pathKey] : undefined) ?? "";
  const candidates = [
    path.join(deps.backendDir, name),
    ...(deps.coreBackendDir ? [path.join(deps.coreBackendDir, name)] : []),
    ...searchPath.split(win ? ";" : ":").filter(Boolean).map((dir) => path.join(dir, name)),
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
  "rpc-server not found. It ships next to llama-server in engine builds made with llama.cpp RPC (GGML_RPC=ON). " +
  "Run `atomic-agent models update` to get the newest engine, or set ATOMIC_AGENT_RPC_SERVER to an rpc-server " +
  "you have, then run this again.\n";

export interface RpcWorkerDeps {
  spawn?: typeof nodeSpawn;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  binary?: string | null;
  addresses?: string[];
  /** Environment and folder rpc-server runs with; Core's backend rules by default. */
  launchEnv?: (binary: string) => CoreBackendSpawn;
}

export async function runModelsRpcWorker(args: readonly string[], deps: RpcWorkerDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const opts = parseRpcWorkerArgs(args);
  if ("error" in opts) {
    err(`models rpc-worker: ${opts.error}\nusage: atomic-agent models rpc-worker [--lan | --host <ip>] [--port <n>] [--cache]\n`);
    return 1;
  }
  const dataDir = deps.binary !== undefined ? "" : getConfig().paths.localModelsDataDir;
  const binary =
    deps.binary !== undefined
      ? deps.binary
      : resolveRpcServerBinary({
          env: process.env,
          backendDir: resolveBackendDir(dataDir),
          coreBackendDir: coreBackendDirOf(dataDir),
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
  // Run it the way Core runs its llama-server: its own folder on the
  // library path (the ggml backends and CUDA runtime sit beside it), and
  // on Windows from that folder, so the GPU backend DLLs load.
  const launch = (deps.launchEnv ?? coreBackendSpawn)(binary);
  const child = (deps.spawn ?? nodeSpawn)(binary, argv, {
    stdio: "inherit",
    env: launch.env,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
  });
  return await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      err(`models rpc-worker: could not start ${binary}: ${e.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal === "SIGINT" || signal === "SIGTERM" ? 0 : (code ?? 1)));
  });
}

/** Folder of the llama-server Core installed, or `null` when it has none. */
function coreBackendDirOf(dataDir: string): string | null {
  try {
    const backend = readCoreBackend(dataDir);
    return backend ? dirname(backend.binary) : null;
  } catch {
    return null;
  }
}
