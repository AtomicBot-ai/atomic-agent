import { describe, expect, it, vi } from "vitest";
import { buildLlamaServerArgs, type DaemonStartOptions } from "./daemon-lifecycle.js";
import {
  assertRpcLaunchable,
  helpListsRpc,
  RPC_UNSUPPORTED_MESSAGE,
  rpcPeerProblem,
  rpcServerArgs,
} from "./rpc-peers.js";

describe("rpcPeerProblem", () => {
  it("accepts a name, an IPv4 and a bracketed IPv6 with a port", () => {
    for (const ok of ["192.168.1.20:50052", "studio.local:50052", "localhost:1", "[fe80::1]:65535"]) {
      expect(rpcPeerProblem(ok)).toBeNull();
    }
  });

  it("refuses what llama.cpp would misread or could be smuggled through", () => {
    for (const bad of ["192.168.1.20", ":50052", "host:0", "host:70000", "a,b:50052", "a b:1", "host:50052,evil:1", "-x:1"]) {
      expect(rpcPeerProblem(bad)).not.toBeNull();
    }
  });
});

describe("rpcServerArgs / buildLlamaServerArgs --rpc", () => {
  const opts: DaemonStartOptions = { dataDir: "/tmp/data", modelId: "qwen-3.5-4b", port: 19091 };
  const build = (o: DaemonStartOptions) => buildLlamaServerArgs(o, "/m.gguf", "qwen-3.5-4b");

  it("joins the peers into one --rpc", () => {
    const args = build({ ...opts, rpcServers: ["10.0.0.2:50052", "10.0.0.3:50052"] });
    expect(args[args.indexOf("--rpc") + 1]).toBe("10.0.0.2:50052,10.0.0.3:50052");
  });

  it("stays byte-identical with no peers, and adds none on a CPU-only launch", () => {
    expect(build({ ...opts, rpcServers: [] })).toEqual(build(opts));
    expect(rpcServerArgs(["10.0.0.2:50052"], "cpu")).toEqual([]);
  });
});

describe("assertRpcLaunchable", () => {
  const source = () => ({ binPath: "/b/llama-server" });

  it("does not run the engine at all without peers", async () => {
    const run = vi.fn(async () => "");
    await assertRpcLaunchable([], source, run);
    await assertRpcLaunchable(undefined, source, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes on a build whose help lists --rpc", async () => {
    const run = vi.fn(async () => "--rpc SERVERS                         comma separated list of RPC servers");
    await expect(assertRpcLaunchable(["10.0.0.2:50052"], source, run)).resolves.toBeUndefined();
  });

  it("refuses a build without RPC with words the operator can act on", async () => {
    const run = vi.fn(async () => "-ncmoe, --n-cpu-moe N\n--fit [on|off]");
    await expect(assertRpcLaunchable(["10.0.0.2:50052"], source, run)).rejects.toThrow(RPC_UNSUPPORTED_MESSAGE);
    await expect(assertRpcLaunchable(["10.0.0.2:50052"], () => null, run)).rejects.toThrow(/no RPC support/);
  });

  it("reads the help text of a build whose --help exits non-zero", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("exit 1"), { stdout: "  --rpc SERVERS" }); });
    await expect(assertRpcLaunchable(["10.0.0.2:50052"], source, run)).resolves.toBeUndefined();
  });

  it("names a malformed peer before touching the engine", async () => {
    const run = vi.fn(async () => "--rpc");
    await expect(assertRpcLaunchable(["nope"], source, run)).rejects.toThrow(/localModels\.managed\.rpcServers/);
    expect(run).not.toHaveBeenCalled();
  });

  it("matches --rpc only as an option", () => {
    expect(helpListsRpc("--rpc SERVERS")).toBe(true);
    expect(helpListsRpc("--rpc-foo")).toBe(false);
    expect(helpListsRpc("grpc-only")).toBe(false);
  });
});
