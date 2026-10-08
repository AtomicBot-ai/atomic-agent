import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreControlClient } from "./core-client.js";
import { coreAssetName, coreChecksum, checkCoreUpdate } from "./core-install.js";
import { CORE_VERSION, coreDataDir, coreKeyForUrl, coreSessionPath, writeCoreJson } from "./core-state.js";
import { coreLoadOverrides, stopCoreSession } from "./core-sessions.js";
import { withCoreOperation } from "./core-operation.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "engine-test-")); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const snapshot = { protocol: 2, version: CORE_VERSION, instance_id: "owned", owner_scope: "cli", data_folder: "/test", sessions: [], clients: [] };

describe("Core host contract", () => {
  it.each([{ protocol: 3 }, { version: "999.0.0" }, { instance_id: "foreign" }, { owner_scope: "app" }, { data_folder: "/foreign" }])("rejects incompatible or foreign owners %j", async change => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ ...snapshot, ...change }));
    const client = new CoreControlClient("http://127.0.0.1:19000", "secret", CORE_VERSION, "owned", request);
    await expect(client.snapshot("/test")).rejects.toThrow("ownership changed");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer secret" } });
  });
  it("checks releases without installing or treating an untested newer Core as compatible", async () => {
    const dir = fixture();
    const request = vi.fn(async () => Response.json({ tag_name: "v999.0.0" }));
    expect(await checkCoreUpdate(dir, request)).toMatchObject({ currentVersion: null, compatibleVersion: CORE_VERSION, latestVersion: "999.0.0", requiresAgentUpdate: true, updateAvailable: true });
    await checkCoreUpdate(dir, request);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("requires one exact checksum entry and supports all shipped CPU targets", () => {
    const hash = "a".repeat(64), asset = coreAssetName(CORE_VERSION, "darwin", "arm64");
    expect(coreChecksum(`${hash}  ${asset}\n`, asset)).toBe(hash);
    expect(() => coreChecksum(`${hash}  ${asset}\n${hash}  ${asset}`, asset)).toThrow("ambiguous");
    expect(() => coreChecksum(`${hash}  other`, asset)).toThrow("missing");
    expect(coreAssetName(CORE_VERSION, "win32", "x64")).toMatch(/windows-msvc.exe$/);
    expect(() => coreAssetName(CORE_VERSION, "linux", "ia32")).toThrow("support");
  });
  it("retains native grammar/slot options while removing Core-owned addressing", () => {
    const o = coreLoadOverrides(["--model", "/m.gguf", "--port", "123", "--host", "127.0.0.1", "--ctx-size", "8192", "--parallel", "2", "--chat-template-file", "/a path/template.jinja", "--cache-type-k", "q8_0"]);
    expect(o).toMatchObject({ ctx_size: 8192, parallel: 2, auto_unload: false });
    expect(o.extra_args).toContain('"/a path/template.jinja"');
    expect(o.extra_args).toContain("--slots");
    expect(o.extra_args).not.toContain("--model");
    expect(o.extra_args).not.toContain("--port");
  });
  it("confines keys to a live owned loopback model session", () => {
    const dir = fixture();
    const record = { coreVersion: CORE_VERSION, instanceId: "owned", pid: process.pid, port: 19091, api_key: "model-secret" };
    writeCoreJson(coreSessionPath(dir, "chat"), record);
    const lock = join(coreDataDir(dir, CORE_VERSION), "atomic-core", "instance.lock");
    writeCoreJson(lock, { state: "ready", pid: process.pid, instance_id: "owned" });
    expect(coreKeyForUrl(dir, "http://127.0.0.1:19091")).toBe("model-secret");
    expect(coreKeyForUrl(dir, "https://example.org:19091")).toBeNull();
    expect(coreKeyForUrl(dir, "http://127.0.0.1:19092")).toBeNull();
    writeCoreJson(lock, { state: "ready", pid: process.pid, instance_id: "foreign" });
    expect(coreKeyForUrl(dir, "http://127.0.0.1:19091")).toBeNull();
  });
  it("never falls through to killing a live model when its Core cannot be reached", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { coreVersion: CORE_VERSION, pid: process.pid });
    await expect(stopCoreSession(dir, "chat")).rejects.toThrow("Reconnect");
  });
  it("rejects a concurrent mutation, then releases ownership after an error", async () => {
    const dir = fixture();
    await expect(withCoreOperation(dir, async () => {
      await expect(withCoreOperation(dir, async () => {})).rejects.toThrow("Another engine operation");
      throw new Error("failed");
    })).rejects.toThrow("failed");
    expect(await withCoreOperation(dir, async () => 42)).toBe(42);
  });
});
