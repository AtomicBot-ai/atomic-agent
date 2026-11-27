import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { CORE_VERSION, coreDataDir, coreKeyForUrl, coreSessionPath, coreVersionDir, orphanedCoreSession, readCoreSession, writeCoreJson } from "./core-state.js";
import { loadCoreSession, recoverOrphanedCoreSessions, stopCoreSession } from "./core-sessions.js";
import { connectCore, ensureCore } from "./core-client.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), snapshot: vi.fn(), instanceId: "owned" }));
vi.mock("./core-client.js", () => ({
  withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake),
  connectCore: vi.fn(),
  ensureCore: vi.fn(),
}));

let dir: string;
let child: ChildProcess | null = null;
const base = { model_id: "test", model_path: "/test.gguf", is_embedding: false, api_key: "old-key", provider: "llamacpp", generation: "g1" };

beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "core-pending-exit-"));
  const binary = join(dir, "binary"); writeFileSync(binary, "fixture");
  writeCoreJson(join(coreVersionDir(dir, CORE_VERSION), "backend.json"), { coreVersion: CORE_VERSION, provider: "llamacpp", binary, version: "b1", backend: "test" });
  // Core is up and owns the session: readCoreSession / coreKeyForUrl see it as live.
  writeCoreJson(join(coreDataDir(dir, CORE_VERSION), "atomic-core", "instance.lock"), { state: "ready", pid: process.pid, instance_id: "owned" });
});
afterEach(() => {
  child?.kill("SIGKILL"); child = null;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise((r) => server.close(() => r(null)));
  return port;
}

/** A live chat session whose model server (the child) keeps running after Core answers the unload. */
async function lingeringSession(): Promise<{ pid: number; port: number }> {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const live = { ...base, pid, port: await freePort() };
  writeCoreJson(coreSessionPath(dir, "chat"), { ...live, coreVersion: CORE_VERSION, instanceId: "owned" });
  writeFileSync(join(dir, "llama-server.pid"), String(pid));
  vi.mocked(connectCore).mockResolvedValue(fake as never);
  fake.snapshot.mockResolvedValue({ instance_id: "owned", sessions: [live] });
  fake.call.mockImplementation(async (path: string) => {
    if (path.endsWith("/unload")) {
      // Core forgets it at once; the process itself has not exited.
      fake.snapshot.mockResolvedValue({ instance_id: "owned", sessions: [] });
      return { success: true };
    }
    if (path.endsWith("/load")) return { session: { ...base, pid: process.pid, port: live.port, api_key: "new-key" }, created: true };
    if (path.endsWith("/load/cancel")) return { cancelled: false };
    throw new Error("unexpected route");
  });
  return { pid, port: live.port };
}

/** Stop as on Windows, with a release wait too short for the lingering server. */
async function stopOnWindows(): Promise<void> {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  try { await expect(stopCoreSession(dir, "chat", { releaseWaitMs: 300 })).resolves.toBe(true); }
  finally { platform.mockRestore(); }
}

const loadCalls = () => fake.call.mock.calls.filter(([path]) => String(path).endsWith("/load")).length;
const record = () => JSON.parse(readFileSync(coreSessionPath(dir, "chat"), "utf8")) as Record<string, unknown>;

describe("a Core model server that has not exited after its stop (ATO-1748)", () => {
  it("keeps its record, marked, and no longer reports it as a live session or key", async () => {
    const { pid, port } = await lingeringSession();
    expect(readCoreSession(dir, "chat")?.pid).toBe(pid);
    await stopOnWindows();
    expect(record()).toMatchObject({ pid, port, awaitingExit: true });
    // Not adopted by the port reclaim, and its old key is not handed out.
    expect(readCoreSession(dir, "chat")).toBeNull();
    expect(coreKeyForUrl(dir, `http://127.0.0.1:${port}`)).toBeNull();
    // The pid mirror goes: it is no longer a running engine.
    expect(existsSync(join(dir, "llama-server.pid"))).toBe(false);
  });

  it("a start on that port waits, then refuses plainly while the old server still runs", async () => {
    const { pid, port } = await lingeringSession();
    await stopOnWindows();
    await expect(loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port, args: [], pendingExitWaitMs: 300 }))
      .rejects.toThrow(`The previous model server (pid ${pid}) has not released port ${port} yet`);
    expect(loadCalls()).toBe(0);
    expect(record()).toMatchObject({ pid, awaitingExit: true });
  });

  it("a start on that port goes ahead once the old server has exited", async () => {
    const { port } = await lingeringSession();
    await stopOnWindows();
    child?.kill("SIGKILL");
    const session = await loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port, args: [], pendingExitWaitMs: 5_000 });
    expect(session.api_key).toBe("new-key");
    expect(loadCalls()).toBe(1);
    expect(record()).toMatchObject({ pid: process.pid, api_key: "new-key" });
    expect(record().awaitingExit).toBeUndefined();
  });

  it("a start on another port does not wait for it", async () => {
    const { port } = await lingeringSession();
    await stopOnWindows();
    const started = Date.now();
    fake.call.mockImplementation(async (path: string) => {
      if (path.endsWith("/load")) return { session: { ...base, pid: process.pid, port: port + 1, api_key: "new-key" }, created: true };
      throw new Error("unexpected route");
    });
    await loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port: port + 1, args: [], pendingExitWaitMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a later stop waits for it again and forgets it once it is gone, without a second unload", async () => {
    const { pid } = await lingeringSession();
    await stopOnWindows();
    await expect(stopCoreSession(dir, "chat", { releaseWaitMs: 300 })).resolves.toBe(true);
    expect(record()).toMatchObject({ pid, awaitingExit: true });
    child?.kill("SIGKILL");
    await expect(stopCoreSession(dir, "chat", { releaseWaitMs: 5_000 })).resolves.toBe(true);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
    expect(fake.call.mock.calls.filter(([path]) => String(path).endsWith("/unload"))).toHaveLength(1);
  });

  describe("once Core itself has gone (models stop, TUI exit)", () => {
    beforeEach(() => rmSync(join(coreDataDir(dir, CORE_VERSION), "atomic-core", "instance.lock"), { force: true }));

    it("is not an orphan: no orphan key, no new Core started to reap it", async () => {
      const { pid, port } = await lingeringSession();
      // No live Core lock: an unmarked record of a live process would be an orphan.
      expect(orphanedCoreSession(dir, "chat")?.pid).toBe(pid);
      await stopOnWindows();
      expect(record()).toMatchObject({ pid, awaitingExit: true });
      expect(orphanedCoreSession(dir, "chat")).toBeNull();
      expect(coreKeyForUrl(dir, `http://127.0.0.1:${port}`)).toBeNull();
      await expect(recoverOrphanedCoreSessions(dir)).resolves.toBe(false);
      expect(ensureCore).not.toHaveBeenCalled();
    });

    it("a later stop with Core down waits for it and forgets it once gone, without a new Core", async () => {
      const { pid } = await lingeringSession();
      await stopOnWindows();
      vi.mocked(connectCore).mockResolvedValue(null);
      await expect(stopCoreSession(dir, "chat", { releaseWaitMs: 300 })).resolves.toBe(true);
      expect(record()).toMatchObject({ pid, awaitingExit: true });
      child?.kill("SIGKILL");
      await expect(stopCoreSession(dir, "chat", { releaseWaitMs: 5_000 })).resolves.toBe(true);
      expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
      expect(ensureCore).not.toHaveBeenCalled();
    });
  });
});
