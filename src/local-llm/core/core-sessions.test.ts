import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_VERSION, coreSessionPath, coreVersionDir, writeCoreJson } from "./core-state.js";
import { loadCoreSession, stopIdleCore } from "./core-sessions.js";
import { connectCore } from "./core-client.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), snapshot: vi.fn(), instanceId: "owned" }));
vi.mock("./core-client.js", () => ({ withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake), connectCore: vi.fn() }));
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

function idleCore(sessions: unknown[], shutdown: () => unknown = () => ({ ok: true, stopping: true })) {
  vi.mocked(connectCore).mockResolvedValue(fake as never);
  fake.snapshot.mockResolvedValue({ sessions });
  fake.call.mockImplementation(async (path: string) => {
    if (path === "/clients") return { client: { id: "me" }, heartbeat_interval_ms: 15_000 };
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
