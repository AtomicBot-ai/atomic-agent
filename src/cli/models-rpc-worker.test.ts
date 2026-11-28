import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  lanAddresses,
  parseRpcWorkerArgs,
  resolveRpcServerBinary,
  RPC_LAN_WARNING,
  RPC_SERVER_MISSING,
  runModelsRpcWorker,
} from "./models-rpc-worker.js";

function fakeSpawn(exit: { code: number | null; signal: string | null }) {
  return vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", exit.code, exit.signal));
    return child;
  });
}

describe("parseRpcWorkerArgs", () => {
  it("binds loopback on port 50052 by default", () => {
    expect(parseRpcWorkerArgs([])).toEqual({ host: "127.0.0.1", port: 50052, cache: false });
  });
  it("opens the network only on --lan or an explicit --host", () => {
    expect(parseRpcWorkerArgs(["--lan", "--port", "6000", "--cache"])).toEqual({ host: "0.0.0.0", port: 6000, cache: true });
    expect(parseRpcWorkerArgs(["--host", "192.168.1.5"])).toMatchObject({ host: "192.168.1.5" });
  });
  it("refuses bad values", () => {
    expect(parseRpcWorkerArgs(["--port", "0"])).toHaveProperty("error");
    expect(parseRpcWorkerArgs(["--host", "evil;rm"])).toHaveProperty("error");
    expect(parseRpcWorkerArgs(["--what"])).toHaveProperty("error");
  });
});

describe("resolveRpcServerBinary", () => {
  const base = { env: { PATH: "/usr/local/bin:/opt/bin" }, backendDir: "/d/backend", platform: "darwin" as const };
  it("prefers the override, then the backend folder, then PATH", () => {
    expect(resolveRpcServerBinary({ ...base, env: { ...base.env, ATOMIC_AGENT_RPC_SERVER: "/x/rpc" }, exists: () => true })).toBe("/x/rpc");
    expect(resolveRpcServerBinary({ ...base, exists: (p) => p === "/d/backend/rpc-server" })).toBe("/d/backend/rpc-server");
    expect(resolveRpcServerBinary({ ...base, exists: (p) => p === "/opt/bin/rpc-server" })).toBe("/opt/bin/rpc-server");
    expect(resolveRpcServerBinary({ ...base, exists: () => false })).toBeNull();
  });

  // ATO-2454: Atomic Core is the default engine, so on most installs the
  // only llama-server (and the rpc-server beside it) is Core's.
  it("finds rpc-server next to the llama-server Atomic Core installed", () => {
    const coreBackendDir = "/d/core/backends/b10298-2.2.0/macos-arm64/build/bin";
    expect(
      resolveRpcServerBinary({ ...base, coreBackendDir, exists: (p) => p === `${coreBackendDir}/rpc-server` }),
    ).toBe(`${coreBackendDir}/rpc-server`);
    // The agent's own engine folder still wins when both have one.
    expect(resolveRpcServerBinary({ ...base, coreBackendDir, exists: () => true })).toBe("/d/backend/rpc-server");
  });

  it("looks for rpc-server.exe with Windows paths and a Path variable of any case", () => {
    const win = {
      env: { Path: "C:\\llama;D:\\tools" },
      backendDir: "C:\\Users\\u\\.atomic-agent\\local-models\\backend",
      coreBackendDir: "C:\\Users\\u\\.atomic-agent\\core\\backends\\x\\build\\bin",
      platform: "win32" as const,
    };
    expect(resolveRpcServerBinary({ ...win, exists: (p) => p === `${win.backendDir}\\rpc-server.exe` })).toBe(
      `${win.backendDir}\\rpc-server.exe`,
    );
    expect(resolveRpcServerBinary({ ...win, exists: (p) => p === `${win.coreBackendDir}\\rpc-server.exe` })).toBe(
      `${win.coreBackendDir}\\rpc-server.exe`,
    );
    expect(resolveRpcServerBinary({ ...win, exists: (p) => p === "D:\\tools\\rpc-server.exe" })).toBe("D:\\tools\\rpc-server.exe");
    // A POSIX name is never what Windows runs.
    expect(resolveRpcServerBinary({ ...win, exists: (p) => p.endsWith("rpc-server") })).toBeNull();
  });
});

describe("runModelsRpcWorker", () => {
  it("starts rpc-server on loopback and prints the line for the main computer", async () => {
    const spawn = fakeSpawn({ code: null, signal: "SIGINT" });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runModelsRpcWorker([], {
      spawn: spawn as never, binary: "/b/rpc-server", stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      "/b/rpc-server",
      ["--host", "127.0.0.1", "--port", "50052"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(out.join("")).toContain(`rpcServers '["127.0.0.1:50052"]'`);
    expect(err.join("")).not.toContain(RPC_LAN_WARNING);
  });

  it("warns on --lan and offers this computer's LAN address", async () => {
    const spawn = fakeSpawn({ code: 0, signal: null });
    const out: string[] = [];
    const err: string[] = [];
    await runModelsRpcWorker(["--lan"], {
      spawn: spawn as never, binary: "/b/rpc-server", addresses: ["192.168.1.7"], stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    });
    expect((spawn.mock.calls[0] as unknown[])[1]).toEqual(["--host", "0.0.0.0", "--port", "50052"]);
    expect(err.join("")).toContain(RPC_LAN_WARNING);
    expect(out.join("")).toContain(`rpcServers '["192.168.1.7:50052"]'`);
  });

  it("runs rpc-server with its own folder's environment, from that folder on Windows", async () => {
    const spawn = fakeSpawn({ code: null, signal: "SIGINT" });
    const launchEnv = vi.fn(() => ({ env: { PATH: "C:\\b;C:\\Windows" }, cwd: "C:\\b" }));
    await runModelsRpcWorker([], {
      spawn: spawn as never, binary: "C:\\b\\rpc-server.exe", launchEnv, stdout: () => {}, stderr: () => {},
    });
    expect(launchEnv).toHaveBeenCalledWith("C:\\b\\rpc-server.exe");
    expect((spawn.mock.calls[0] as unknown[])[2]).toEqual({
      stdio: "inherit", env: { PATH: "C:\\b;C:\\Windows" }, cwd: "C:\\b",
    });
  });

  it("says where rpc-server comes from when it is missing", async () => {
    const err: string[] = [];
    expect(await runModelsRpcWorker([], { binary: null, stderr: (s) => err.push(s), stdout: () => {} })).toBe(1);
    expect(err.join("")).toBe(RPC_SERVER_MISSING);
  });

  it("lists only external IPv4 addresses", () => {
    expect(lanAddresses({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      en0: [{ address: "192.168.1.7", family: "IPv4", internal: false } as never, { address: "fe80::1", family: "IPv6", internal: false } as never],
    })).toEqual(["192.168.1.7"]);
  });
});
