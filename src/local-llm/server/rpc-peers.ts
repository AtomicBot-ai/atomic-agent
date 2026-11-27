import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceProbeSpawn } from "../backend/gpu-devices.js";

/**
 * `localModels.managed.rpcServers` (ATO-2338): other computers on the
 * same network that lend their memory and compute to one model through
 * llama.cpp RPC. Each runs `atomic-agent models rpc-worker`, which starts
 * llama.cpp's `rpc-server`; this computer's managed launch then adds
 * `--rpc host:port,...` and llama.cpp places layers on those devices as
 * if they were local GPUs. Empty (the default) keeps the launch
 * byte-identical.
 *
 * llama.cpp's RPC protocol has no authentication or encryption: a worker
 * must only listen on a network the operator trusts (the worker command
 * binds loopback unless asked for `--lan`).
 *
 * Precedent: llama.cpp `tools/rpc`, exo, Mesh-LLM (Goose).
 */
export const DEFAULT_RPC_PORT = 50052;

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_BRACKETED = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Why `peer` is not a `host:port` llama.cpp can dial, or `null` when it
 * is. The host is a name, an IPv4 address or a bracketed IPv6 address;
 * the port is 1..65535. Nothing else may ride along (llama.cpp splits
 * the list on commas, so a comma or a space would smuggle in a peer).
 */
export function rpcPeerProblem(peer: string): string | null {
  const at = peer.lastIndexOf(":");
  if (at <= 0) return `expected host:port, got ${JSON.stringify(peer)}`;
  const host = peer.slice(0, at);
  const port = peer.slice(at + 1);
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return `port must be 1..65535 in ${JSON.stringify(peer)}`;
  }
  if (!(IPV4.test(host) || IPV6_BRACKETED.test(host) || HOSTNAME.test(host))) {
    return `not a host name or address: ${JSON.stringify(host)}`;
  }
  return null;
}

/** `--rpc a,b` for a launch that offloads; nothing for none or CPU-only. */
export function rpcServerArgs(peers: readonly string[] | undefined, device: string | undefined): string[] {
  if (!peers || peers.length === 0 || device === "cpu") return [];
  return ["--rpc", peers.join(",")];
}

/** Whether a `llama-server --help` text lists the `--rpc` option. */
export function helpListsRpc(helpText: string): boolean {
  return /(^|[\s,])--rpc(?![\w-])/m.test(helpText);
}

export const RPC_UNSUPPORTED_MESSAGE =
  "this model engine build has no RPC support (llama.cpp built without GGML_RPC), " +
  "so localModels.managed.rpcServers cannot be used; set it to [] or install an engine build with RPC";

export type HelpRunner = (binPath: string, spawn?: DeviceProbeSpawn) => Promise<string>;

const runHelp: HelpRunner = async (binPath, spawn) => {
  const { stdout, stderr } = await promisify(execFile)(binPath, ["--help"], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(spawn?.env ? { env: spawn.env } : {}),
    ...(spawn?.cwd ? { cwd: spawn.cwd } : {}),
  });
  return `${stdout}\n${stderr}`;
};

/**
 * Refuse a launch with RPC peers on an engine that cannot dial them,
 * before the model loads, with words the operator can act on. A build
 * without RPC would otherwise exit on an unknown argument. Peers are
 * validated here too, so a hand-edited value never reaches argv.
 */
export async function assertRpcLaunchable(
  peers: readonly string[] | undefined,
  engineSource: () => { binPath: string; spawn?: DeviceProbeSpawn } | null,
  run: HelpRunner = runHelp,
): Promise<void> {
  if (!peers || peers.length === 0) return;
  for (const peer of peers) {
    const problem = rpcPeerProblem(peer);
    if (problem) throw new Error(`localModels.managed.rpcServers: ${problem}`);
  }
  const source = engineSource();
  if (!source) throw new Error(RPC_UNSUPPORTED_MESSAGE);
  let help: string;
  try {
    help = await run(source.binPath, source.spawn);
  } catch (err) {
    // `--help` exits non-zero on some builds; its text is still the answer.
    const e = err as { stdout?: string; stderr?: string };
    help = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  if (!helpListsRpc(help)) throw new Error(RPC_UNSUPPORTED_MESSAGE);
}
