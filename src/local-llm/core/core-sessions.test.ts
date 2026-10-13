import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_VERSION, coreSessionPath, coreVersionDir, writeCoreJson } from "./core-state.js";
import { loadCoreSession, recoverOrphanedCoreSessions, retireIdleCore, stopCoreSession, stopIdleCore } from "./core-sessions.js";
import { connectCore, ensureCore } from "./core-client.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), snapshot: vi.fn(), instanceId: "owned" }));
vi.mock("./core-client.js", () => ({ withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake), connectCore: vi.fn(), ensureCore: vi.fn() }));
let dir: string;
const session = { pid: process.pid, port: 19091, model_id: "test", model_path: "/test.gguf", is_embedding: false, api_key: "test-key", provider: "llamacpp", generation: "new" };
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "core-load-"));
  const binary = join(dir, "binary"); writeFileSync(binary, "fixture");
  writeCoreJson(join(coreVersionDir(dir, CORE_VERSION), "backend.json"), { coreVersion: CORE_VERSION, provider: "llamacpp", binary, version: "b1", backend: "test" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it("unloads a newly ready model when cancellation wins before its reply is handled", async () => {
  const abort = new AbortController();
  fake.snapshot.mockResolvedValueOnce({ sessions: [] }).mockResolvedValue({ sessions: [session] });
  fake.call.mockImplementation(async (path: string) => {
    if (path.endsWith("/load")) { abort.abort(); return { session, created: true }; }
    if (path.endsWith("/load/cancel")) return { cancelled: false };
    if (path.endsWith("/unload")) return { success: true };
    throw new Error("unexpected route");
  });
  await expect(loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port: 19091, args: [], signal: abort.signal })).rejects.toThrow();
  expect(fake.call).toHaveBeenCalledWith("/models/llamacpp/test/unload", {}, { timeoutMs: 30_000 });
  expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
});
it("keeps recovery ownership when cancellation cleanup fails", async () => {
  fake.snapshot.mockResolvedValueOnce({ sessions: [] }).mockResolvedValue({ sessions: [session] });
  fake.call.mockImplementation(async (path: string) => {
    if (path.endsWith("/load")) throw new Error("response lost");
    if (path.endsWith("/load/cancel")) return { cancelled: false };
    if (path.endsWith("/unload")) return { success: false };
  });
  await expect(loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port: 19091, args: [] })).rejects.toThrow("Retry Stop");
  expect(existsSync(coreSessionPath(dir, "chat"))).toBe(true);
});
it("never unloads a session another caller already had", async () => {
  fake.snapshot.mockResolvedValue({ sessions: [session] });
  fake.call.mockRejectedValue(new Error("response lost"));
  await expect(loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port: 19091, args: [] })).rejects.toThrow("response lost");
  expect(fake.call.mock.calls.some(([path]) => path.endsWith("/unload"))).toBe(false);
});

function idleCore(sessions: unknown[], shutdown: () => unknown = () => ({ ok: true, stopping: true }), embedding?: { enabled: boolean }) {
  vi.mocked(connectCore).mockResolvedValue(fake as never);
  fake.snapshot.mockResolvedValue({ sessions });
  fake.call.mockImplementation(async (path: string) => {
    if (path === "/clients") return { client: { id: "me" }, heartbeat_interval_ms: 15_000 };
    if (path === "/embedding/status") {
      if (embedding) return embedding;
      // A Core without the embedding module (0.11) answers 404: not busy.
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    if (path === "/shutdown") return shutdown();
    if (path === "/clients/me") return {};
    throw new Error("unexpected route");
  });
}
it("shuts down an idle Core as its own client, without force", async () => {
  idleCore([]);
  await expect(stopIdleCore(dir)).resolves.toBe(true);
  expect(fake.call).toHaveBeenCalledWith("/shutdown", { client_id: "me" });
  expect(fake.call.mock.calls.some(([path]) => path === "/clients/me")).toBe(false);
});
it("leaves Core running while a model session remains", async () => {
  idleCore([session]);
  await expect(stopIdleCore(dir)).resolves.toBe(false);
  expect(fake.call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
  expect(fake.call).toHaveBeenCalledWith("/clients/me", undefined, { method: "DELETE" });
});
it("leaves Core running while its embedding module is enabled", async () => {
  idleCore([], undefined, { enabled: true });
  await expect(stopIdleCore(dir)).resolves.toBe(false);
  expect(fake.call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
});
it("shuts down a Core whose embedding module is off", async () => {
  idleCore([], undefined, { enabled: false });
  await expect(stopIdleCore(dir)).resolves.toBe(true);
});
it("leaves Core running when another client is attached", async () => {
  idleCore([], () => { throw new Error("Other clients are still attached to this core."); });
  await expect(stopIdleCore(dir)).resolves.toBe(false);
  expect(fake.call).toHaveBeenCalledWith("/clients/me", undefined, { method: "DELETE" });
});
it("does nothing when Core is not running or was never used", async () => {
  vi.mocked(connectCore).mockResolvedValue(null);
  await expect(stopIdleCore(dir)).resolves.toBe(false);
  const fresh = mkdtempSync(join(tmpdir(), "core-none-"));
  try {
    await expect(stopIdleCore(fresh)).resolves.toBe(false);
    expect(existsSync(join(fresh, "core"))).toBe(false);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
  expect(fake.call).not.toHaveBeenCalled();
});

it("asks Core to offload the vision projector and keeps the session's projector answer", async () => {
  fake.snapshot.mockResolvedValue({ sessions: [] });
  const dropped = { ...session, mmproj_path: null };
  fake.call.mockImplementation(async (path: string) => {
    if (path.endsWith("/load")) return { session: dropped, created: true };
    throw new Error("unexpected route");
  });
  const loaded = await loadCoreSession(dir, { role: "chat", modelId: "test", modelPath: "/test.gguf", port: 19091, args: [], mmprojPath: "/mmproj.gguf" });
  const body = fake.call.mock.calls.find(([path]) => String(path).endsWith("/load"))?.[1] as { overrides: Record<string, unknown>; mmprojPath?: string };
  expect(body.overrides).toMatchObject({ offload_mmproj: true });
  expect(body.mmprojPath).toBe("/mmproj.gguf");
  // Core retried without the projector: the caller must not claim vision.
  expect(loaded.mmproj_path).toBeNull();
});

it("gives up on an unresponsive Core within its bound when retiring it", async () => {
  vi.mocked(connectCore).mockImplementation(() => new Promise(() => {}));
  const started = Date.now();
  await expect(retireIdleCore(dir, 100)).resolves.toBe(false);
  expect(Date.now() - started).toBeLessThan(2_000);
});

describe("a Core that crashed while its model kept running", () => {
  let child: ChildProcess | null = null;
  afterEach(() => { child?.kill("SIGKILL"); child = null; });

  function orphan(role: "chat" | "embedding" = "chat"): number {
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    const pid = child.pid!;
    // No Core lock at all: its owner is gone; the model server (the child) lives on.
    writeCoreJson(coreSessionPath(dir, role), { ...session, pid, coreVersion: CORE_VERSION, instanceId: "dead" });
    writeFileSync(join(dir, role === "chat" ? "llama-server.pid" : "llama-embed.pid"), String(pid));
    return pid;
  }

  it("restarts Core so it reaps the orphan, then forgets it, before a start", async () => {
    orphan();
    // The new Core owner reaps what its process journal names.
    vi.mocked(ensureCore).mockImplementation(async () => { child?.kill("SIGTERM"); return fake as never; });
    await expect(recoverOrphanedCoreSessions(dir)).resolves.toBe(true);
    expect(ensureCore).toHaveBeenCalledWith(dir, CORE_VERSION);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
    expect(existsSync(join(dir, "llama-server.pid"))).toBe(false);
  });

  it("stops it through a restarted Core instead of asking to reconnect", async () => {
    orphan("embedding");
    vi.mocked(connectCore).mockResolvedValue(null);
    vi.mocked(ensureCore).mockImplementation(async () => { child?.kill("SIGTERM"); return fake as never; });
    await expect(stopCoreSession(dir, "embedding")).resolves.toBe(true);
    expect(existsSync(coreSessionPath(dir, "embedding"))).toBe(false);
  });

  it("says so plainly, and never signals the process itself, when Core will not reap it", async () => {
    const pid = orphan();
    vi.mocked(ensureCore).mockResolvedValue(fake as never);
    await expect(recoverOrphanedCoreSessions(dir)).rejects.toThrow(`model server (pid ${pid}) kept running`);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(readFileSync(coreSessionPath(dir, "chat"), "utf8")).toContain(String(pid));
  }, 15_000);

  it("does nothing when there is no orphan", async () => {
    await expect(recoverOrphanedCoreSessions(dir)).resolves.toBe(false);
    expect(ensureCore).not.toHaveBeenCalled();
  });
});
