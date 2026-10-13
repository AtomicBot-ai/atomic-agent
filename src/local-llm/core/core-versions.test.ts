import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CORE_VERSION, CORE_VERSIONS, activeCoreVersion, coreBinary, coreRoot, coreVersionDir, readCoreBackend, writeCoreJson } from "./core-state.js";
import { isCoreInstalled } from "./core-install.js";
import { isCoreBackendInstalled } from "./core-backend.js";
import { retireOlderCores, type CoreControlClient } from "./core-client.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "core-versions-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("pins 0.13.6 as the install target and keeps 0.11.2 readable", () => {
  expect(CORE_VERSION).toBe("0.13.6");
  expect(CORE_VERSIONS).toContain("0.11.2");
});

it("keeps an existing 0.11.2 install active and usable until it is updated", () => {
  const dir = fixture();
  const old = "0.11.2";
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
