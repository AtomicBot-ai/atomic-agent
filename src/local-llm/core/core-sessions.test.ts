import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_VERSION, coreSessionPath, coreVersionDir, writeCoreJson } from "./core-state.js";
import { loadCoreSession } from "./core-sessions.js";

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
