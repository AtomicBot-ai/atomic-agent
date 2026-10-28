import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreControlClient } from "./core-client.js";
import { unloadRetiredCoreSessions } from "./core-retire-sessions.js";
import { CORE_VERSION, CORE_VERSIONS, coreSessionPath, writeCoreJson } from "./core-state.js";

/** A Core version this build no longer makes active. */
const OLD_VERSION = CORE_VERSIONS[0];

let dir: string;
let child: ChildProcess | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-retire-"));
});
afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
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

/**
 * The agent's chat session on an older Core, its model server a live
 * child that exits `exitAfterMs` after the unload is answered.
 */
async function retiredSession(exitAfterMs: number | null): Promise<{ client: CoreControlClient; pid: number }> {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const live = {
    pid, port: await freePort(), model_id: "test", model_path: "/test.gguf", is_embedding: false,
    api_key: "k", provider: "llamacpp", generation: "g1",
  };
  writeCoreJson(coreSessionPath(dir, "chat"), { ...live, coreVersion: OLD_VERSION, instanceId: "old" });
  const client = {
    version: OLD_VERSION,
    instanceId: "old",
    snapshot: vi.fn(async () => ({ sessions: [live] })),
    call: vi.fn(async (path: string) => {
      if (!path.endsWith("/unload")) throw new Error("unexpected route");
      if (exitAfterMs !== null) setTimeout(() => child?.kill("SIGKILL"), exitAfterMs);
      return { success: true };
    }),
  } as unknown as CoreControlClient;
  return { client, pid };
}

describe("unloading the agent's sessions on a retired Core (ATO-304)", () => {
  it("sanity: the test's old version is not the active one", () => {
    expect(OLD_VERSION).not.toBe(CORE_VERSION);
  });

  it("on Windows, returns only once the unloaded server has exited", async () => {
    const { client, pid } = await retiredSession(300);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const started = Date.now();
    await unloadRetiredCoreSessions(dir, client, 5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
  });

  it("on Windows, gives up after its bound and notes it in the server log", async () => {
    const { client, pid } = await retiredSession(null);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await unloadRetiredCoreSessions(dir, client, 300);
    expect(readFileSync(join(dir, "llama-server.log"), "utf8")).toContain(`pid ${pid} was still running`);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
  });

  it("does not wait on macOS or Linux", async () => {
    const { client } = await retiredSession(null);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const started = Date.now();
    await unloadRetiredCoreSessions(dir, client, 5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(join(dir, "llama-server.log"))).toBe(false);
    expect(existsSync(coreSessionPath(dir, "chat"))).toBe(false);
  });
});
