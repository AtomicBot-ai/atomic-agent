import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreControlClient } from "./core-client.js";
import { coreAssetName, coreChecksum, checkCoreUpdate } from "./core-install.js";
import { CORE_VERSION, coreDataDir, coreKeyForUrl, coreSessionPath, orphanedCoreSession, readCoreSession, writeCoreJson } from "./core-state.js";
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
  it("accepts its own data folder reported through a symlinked path", async () => {
    const dir = fixture(), real = join(dir, "real"), link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    const request = vi.fn<typeof fetch>(async () => Response.json({ ...snapshot, data_folder: link }));
    const client = new CoreControlClient("http://127.0.0.1:19000", "secret", CORE_VERSION, "owned", request);
    await expect(client.snapshot(realpathSync(real))).resolves.toMatchObject({ data_folder: link });
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
    // The vision projector is offloaded as on the llama-server engine, not
    // kept on the CPU by Core's default --no-mmproj-offload.
    expect(o).toMatchObject({ offload_mmproj: true });
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
  it("keeps the key of a model whose Core crashed, and reports it as orphaned", () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { coreVersion: CORE_VERSION, instanceId: "owned", pid: process.pid, port: 19091, api_key: "model-secret" });
    const lock = join(coreDataDir(dir, CORE_VERSION), "atomic-core", "instance.lock");
    // Core is gone (no ready owner), its llama-server (this process) lives on.
    writeCoreJson(lock, { state: "stopped", pid: process.pid, instance_id: "owned" });
    expect(readCoreSession(dir, "chat")).toBeNull();
    expect(orphanedCoreSession(dir, "chat")).toMatchObject({ pid: process.pid, port: 19091 });
    expect(coreKeyForUrl(dir, "http://127.0.0.1:19091")).toBe("model-secret");
    // A live Core under another instance has reaped what it could: not an orphan.
    writeCoreJson(lock, { state: "ready", pid: process.pid, instance_id: "foreign" });
    expect(orphanedCoreSession(dir, "chat")).toBeNull();
  });
  it("never falls through to killing a live model when its Core cannot be reached", async () => {
    const dir = fixture();
    writeCoreJson(coreSessionPath(dir, "chat"), { coreVersion: CORE_VERSION, pid: process.pid });
    // Core is not installed here, so it cannot be restarted to reap the
    // model: the stop says so plainly and keeps the record (and this process).
    await expect(stopCoreSession(dir, "chat")).rejects.toThrow("stopped unexpectedly");
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(true);
  });
  it("stops nothing and takes no engine lock when Core owns no session", async () => {
    const dir = fixture();
    await expect(stopCoreSession(dir, "chat")).resolves.toBe(false);
    expect(existsSync(join(dir, "core"))).toBe(false);
  });
  it("waits on a Core operation in progress instead of reporting a stop that did nothing", async () => {
    const dir = fixture();
    await withCoreOperation(dir, async () => {
      await expect(stopCoreSession(dir, "chat", { waitMs: 0 })).rejects.toThrow("Another engine operation");
    });
    await expect(stopCoreSession(dir, "chat")).resolves.toBe(false);
  });
  it("lets a stop wait, bounded, for an operation another frontend is running", async () => {
    const dir = fixture();
    let release!: () => void;
    const held = withCoreOperation(dir, () => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(r => setTimeout(r, 20));
    const stop = stopCoreSession(dir, "chat", { waitMs: 5_000 });
    setTimeout(() => release(), 300);
    await expect(stop).resolves.toBe(false);
    await held;
    // Bounded: still held after the wait, it fails instead of hanging.
    let releaseAgain!: () => void;
    const again = withCoreOperation(dir, () => new Promise<void>(resolve => { releaseAgain = resolve; }));
    await new Promise(r => setTimeout(r, 20));
    await expect(withCoreOperation(dir, async () => {}, { waitMs: 300 })).rejects.toThrow("Another engine operation");
    releaseAgain();
    await again;
  });
  it("rejects a concurrent mutation, then releases ownership after an error", async () => {
    const dir = fixture();
    await expect(withCoreOperation(dir, async () => {
      await expect(withCoreOperation(dir, async () => {}, { waitMs: 0 })).rejects.toThrow("Another engine operation");
      throw new Error("failed");
    })).rejects.toThrow("failed");
    expect(await withCoreOperation(dir, async () => 42)).toBe(42);
  });
});
