import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CORE_VERSION, CORE_VERSIONS, activeCoreVersion, coreBinary, coreRoot, coreSessionPath, coreVersionDir, readCoreBackend, writeCoreJson } from "./core-state.js";
import { isCoreInstalled } from "./core-install.js";
import { isCoreBackendInstalled } from "./core-backend.js";
import { retireOlderCores, type CoreControlClient } from "./core-client.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "core-versions-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("pins 0.18.6 as the install target and keeps 0.11.2, 0.13.6 and 0.16.0 readable", () => {
  expect(CORE_VERSION).toBe("0.18.6");
  expect(CORE_VERSIONS).toEqual(["0.11.2", "0.13.6", "0.16.0", "0.18.6"]);
});

it.each(["0.11.2", "0.13.6", "0.16.0"])("keeps an existing %s install active and usable until it is updated", old => {
  const dir = fixture();
  mkdirSync(dirname(coreBinary(dir, old)), { recursive: true });
  writeFileSync(coreBinary(dir, old), "fixture");
  writeCoreJson(join(coreVersionDir(dir, old), "verified.json"), { version: old, sha256: "a".repeat(64) });
  const server = join(dir, "llama-server");
  writeFileSync(server, "fixture");
  writeCoreJson(join(coreVersionDir(dir, old), "backend.json"), { coreVersion: old, provider: "llamacpp", version: "b1", backend: "test", binary: server, installedAt: "2026-10-01T00:00:00.000Z" });
  writeCoreJson(join(coreRoot(dir), "active.json"), { version: old });
  expect(activeCoreVersion(dir)).toBe(old);
  expect(isCoreInstalled(dir)).toBe(true);
  expect(readCoreBackend(dir)?.coreVersion).toBe(old);
  expect(isCoreBackendInstalled(dir)).toBe(true);
});

it("falls back to the pinned version for an unknown active record", () => {
  const dir = fixture();
  writeCoreJson(join(coreRoot(dir), "active.json"), { version: "0.1.0" });
  expect(activeCoreVersion(dir)).toBe(CORE_VERSION);
  expect(() => coreVersionDir(dir, "0.1.0")).toThrow("Update Agent first");
});

it("asks an idle older Core to shut down once, without force", async () => {
  const dir = fixture();
  const call = vi.fn(async (path: string) => {
    if (path === "/clients") return { client: { id: "me" } };
    return { ok: true };
  });
  const client = { call, snapshot: vi.fn(async () => ({ sessions: [] })) } as unknown as CoreControlClient;
  const connect = vi.fn(async () => client);
  await retireOlderCores(dir, connect);
  await retireOlderCores(dir, connect);
  expect(connect).toHaveBeenCalledTimes(CORE_VERSIONS.length - 1);
  expect(connect).toHaveBeenCalledWith(dir, "0.11.2");
  expect(connect).toHaveBeenCalledWith(dir, "0.13.6");
  expect(connect).toHaveBeenCalledWith(dir, "0.16.0");
  expect(connect).not.toHaveBeenCalledWith(dir, CORE_VERSION);
  expect(call).toHaveBeenCalledWith("/shutdown", { client_id: "me" });
});

it("leaves an older Core that still serves a model, and survives one that does not answer", async () => {
  const busy = fixture();
  const call = vi.fn(async (path: string) => (path === "/clients" ? { client: { id: "me" } } : {}));
  const client = { call, snapshot: vi.fn(async () => ({ sessions: [{ model_id: "m" }] })) } as unknown as CoreControlClient;
  await retireOlderCores(busy, async () => client);
  expect(call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
  await expect(retireOlderCores(fixture(), async () => { throw new Error("unreachable"); })).resolves.toBeUndefined();
});

describe("an older Core that still holds the agent's own model (ATO-841)", () => {
  const session = { pid: 4242, port: 19091, model_id: "chat-model", model_path: "/models/chat.gguf", api_key: "k", is_embedding: false, provider: "llamacpp", generation: "g1" };
  function olderCore(sessions: Array<Record<string, unknown>>) {
    let live = sessions;
    const call = vi.fn(async (path: string) => {
      if (path === "/clients") return { client: { id: "me" } };
      if (path.endsWith("/unload")) { live = live.filter(s => !path.includes(`/${String(s.model_id)}/`)); return { success: true }; }
      if (path === "/embedding/status") return { enabled: false };
      return { ok: true };
    });
    const client = { version: "0.16.0", instanceId: "old-instance", call, snapshot: vi.fn(async () => ({ sessions: live })) } as unknown as CoreControlClient;
    return { client, call };
  }
  const connectOnly = (client: CoreControlClient) => async (_dir: string, version: string) => (version === "0.16.0" ? client : null);

  it("leaves the session loaded when the new pin's Core starts for anything but a model start (image generation), and a later chat start still unloads it", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { ...session, coreVersion: "0.16.0", instanceId: "old-instance" });
    const { client, call } = olderCore([session]);
    // What ensureCore does for withImageCore and backend install: no retireSessions.
    await retireOlderCores(dir, connectOnly(client));
    expect(call.mock.calls.some(([path]) => String(path).endsWith("/unload"))).toBe(false);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(true);
    expect(call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
    // The once-per-process idle retirement must not use up the session retirement.
    await retireOlderCores(dir, connectOnly(client), { retireSessions: true });
    expect(call).toHaveBeenCalledWith("/models/llamacpp/chat-model/unload", {}, { timeoutMs: 30_000 });
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
  });

  it("unloads the recorded session through the old Core, drops the record, then shuts that Core down", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { ...session, coreVersion: "0.16.0", instanceId: "old-instance" });
    const { client, call } = olderCore([session]);
    await retireOlderCores(dir, connectOnly(client), { retireSessions: true });
    expect(call).toHaveBeenCalledWith("/models/llamacpp/chat-model/unload", {}, { timeoutMs: 30_000 });
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
    expect(call).toHaveBeenCalledWith("/shutdown", { client_id: "me" });
  });

  it("leaves another client's session on the old Core alone", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { ...session, coreVersion: "0.16.0", instanceId: "old-instance" });
    const { client, call } = olderCore([session, { ...session, pid: 5151, port: 19095, model_id: "someone-else", model_path: "/models/other.gguf" }]);
    await retireOlderCores(dir, connectOnly(client), { retireSessions: true });
    const unloads = call.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith("/unload"));
    expect(unloads).toEqual(["/models/llamacpp/chat-model/unload"]);
    expect(call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
  });

  it("does not unload a recorded session that changed owner or process", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { ...session, coreVersion: "0.16.0", instanceId: "old-instance" });
    const { client, call } = olderCore([{ ...session, pid: 9999 }]);
    await retireOlderCores(dir, connectOnly(client), { retireSessions: true });
    expect(call.mock.calls.some(([path]) => String(path).endsWith("/unload"))).toBe(false);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(true);
  });

  it("keeps the session while that older version is still the active one", async () => {
    const dir = fixture();
    writeCoreJson(join(coreRoot(dir), "active.json"), { version: "0.16.0" });
    writeCoreJson(coreSessionPath(dir, "chat"), { ...session, coreVersion: "0.16.0", instanceId: "old-instance" });
    const { client, call } = olderCore([session]);
    await retireOlderCores(dir, connectOnly(client), { retireSessions: true });
    expect(call.mock.calls.some(([path]) => String(path).endsWith("/unload"))).toBe(false);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(true);
    expect(call.mock.calls.some(([path]) => path === "/shutdown")).toBe(false);
  });
});
