import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: execSyncMock };
});

import {
  resolveEmbeddingPidFilePath,
  resolveLogFilePath,
  resolvePidFilePath,
} from "../backend-paths.js";
import { stopDaemon, stopEmbeddingDaemon } from "./daemon-lifecycle.js";
import { isPortOpen } from "./process-release.js";

/**
 * ATO-304: on Windows `taskkill /F` returns before the server has exited
 * and freed its port, so a model switch started the next server into
 * "address already in use". The stop now waits for both, bounded.
 */

const dirs: string[] = [];
const servers: Server[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "win-stop-"));
  dirs.push(dir);
  return dir;
}

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((sock) => sock.destroy());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const { server, port } = await listen();
  await new Promise((r) => server.close(() => r(null)));
  return port;
}

/**
 * `process.kill` as the stop sees it: signal 0 answers "alive" for the
 * first `aliveFor` probes, then ESRCH. `onExit` runs once, at the first
 * ESRCH. Every call is recorded.
 */
function fakeProcess(aliveFor: number, onExit?: () => void): Array<string | number | undefined> {
  const calls: Array<string | number | undefined> = [];
  let probes = 0;
  let exited = false;
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    calls.push(signal);
    if (signal !== 0) return true;
    if (probes++ < aliveFor) return true;
    if (!exited) {
      exited = true;
      onExit?.();
    }
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  return calls;
}

function onPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

beforeEach(() => {
  execSyncMock.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => (s.listening ? s.close(() => r(null)) : r(null)))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stopDaemon on Windows", () => {
  it("after taskkill, waits until the process is gone and its port is free", async () => {
    onPlatform("win32");
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), "4242", "utf-8");
    const { server, port } = await listen();
    // Alive for the ownership check and two polls; the port is let go
    // only as the process exits, the way a dying server holds it.
    let exited = false;
    const calls = fakeProcess(3, () => {
      exited = true;
      server.close();
    });

    await stopDaemon(dir, { port, timeoutMs: 3000 });

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(String(execSyncMock.mock.calls[0]?.[0])).toBe("taskkill /PID 4242 /T /F");
    expect(calls.filter((s) => s === 0).length).toBeGreaterThanOrEqual(4);
    expect(calls).not.toContain("SIGTERM");
    expect(exited).toBe(true);
    // Returned only once the port binds again: the next start can take it.
    expect(await isPortOpen(port)).toBe(false);
    expect(existsSync(resolvePidFilePath(dir))).toBe(false);
  });

  it("gives up after the bound, notes it in the server log and still finishes the stop", async () => {
    onPlatform("win32");
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), "4242", "utf-8");
    fakeProcess(Number.POSITIVE_INFINITY);

    const started = Date.now();
    await stopDaemon(dir, { port: await freePort(), timeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(resolveLogFilePath(dir), "utf-8")).toContain("pid 4242 was still running");
    expect(existsSync(resolvePidFilePath(dir))).toBe(false);
  });

  it("waits for a port still held after the process is gone, up to the bound", async () => {
    onPlatform("win32");
    const dir = dataDir();
    writeFileSync(resolvePidFilePath(dir), "4242", "utf-8");
    const { port } = await listen();
    fakeProcess(1);

    await stopDaemon(dir, { port, timeoutMs: 300 });

    expect(readFileSync(resolveLogFilePath(dir), "utf-8")).toContain(`port ${port} was still in use`);
    expect(existsSync(resolvePidFilePath(dir))).toBe(false);
  });
});

describe("stopEmbeddingDaemon on Windows", () => {
  it("waits the same way after taskkill", async () => {
    onPlatform("win32");
    const dir = dataDir();
    writeFileSync(resolveEmbeddingPidFilePath(dir), "5151", "utf-8");
    const calls = fakeProcess(2);

    await stopEmbeddingDaemon(dir, { port: await freePort(), timeoutMs: 3000 });

    expect(String(execSyncMock.mock.calls[0]?.[0])).toBe("taskkill /PID 5151 /T /F");
    expect(calls.filter((s) => s === 0).length).toBeGreaterThanOrEqual(3);
    expect(existsSync(resolveEmbeddingPidFilePath(dir))).toBe(false);
  });
});

describe("stopDaemon on macOS and Linux (unchanged)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`${platform}: SIGTERM, no taskkill, no wait on the port`, async () => {
      onPlatform(platform);
      const dir = dataDir();
      writeFileSync(resolvePidFilePath(dir), "4242", "utf-8");
      // Held for the whole stop: a port wait would run to its bound.
      const { port } = await listen();
      const calls = fakeProcess(1);

      const started = Date.now();
      await stopDaemon(dir, { port, timeoutMs: 5000 });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(calls).toContain("SIGTERM");
      expect(existsSync(resolvePidFilePath(dir))).toBe(false);
      expect(existsSync(resolveLogFilePath(dir))).toBe(false);
    });
  }
});
