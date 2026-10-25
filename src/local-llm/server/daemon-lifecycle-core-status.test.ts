import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/** The live Core session the control API reports for the recorded role. */
const coreSessionStatusMock = vi.hoisted(() => vi.fn());
vi.mock("../core/core-sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/core-sessions.js")>()),
  coreSessionStatus: coreSessionStatusMock,
}));

import { coreSessionPath } from "../core/core-state.js";
import { getDaemonStatus, getEmbeddingDaemonStatus } from "./daemon-lifecycle.js";

const dirs: string[] = [];
function dataDirWithRecord(role: "chat" | "embedding"): string {
  const dir = mkdtempSync(join(tmpdir(), "core-status-"));
  dirs.push(dir);
  // Only its presence routes status to Core; an unreadable record is no orphan.
  mkdirSync(dirname(coreSessionPath(dir, role)), { recursive: true });
  writeFileSync(coreSessionPath(dir, role), "{}");
  return dir;
}

/** `/health` passes without a key (as llama.cpp's does); `/props` answers `propsStatus`. */
function stubServer(propsStatus: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    if (path === "/props") return new Response("{}", { status: propsStatus });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const session = { pid: process.pid, port: 19091, model_id: "m", model_path: "/m.gguf", api_key: "session-key", is_embedding: false, provider: "llamacpp" };

afterEach(() => {
  vi.unstubAllGlobals();
  coreSessionStatusMock.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Core session health asks a key-guarded endpoint (ATO-840)", () => {
  it("is not healthy, and says the key does not match, when /health passes but the session's key gets 401", async () => {
    coreSessionStatusMock.mockResolvedValue(session);
    const fetchMock = stubServer(401);
    const status = await getDaemonStatus(dataDirWithRecord("chat"), 19091);
    expect(status).toMatchObject({ running: true, healthy: false, loading: false, authMismatch: true });
    const props = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/props"));
    expect((props?.[1] as RequestInit | undefined)?.headers).toMatchObject({ authorization: "Bearer session-key" });
  });

  it("stays healthy when the session's key is accepted", async () => {
    coreSessionStatusMock.mockResolvedValue(session);
    stubServer(200);
    const status = await getDaemonStatus(dataDirWithRecord("chat"), 19091);
    expect(status.healthy).toBe(true);
    expect(status.authMismatch).toBeUndefined();
  });

  it("keeps /health's verdict when /props gives any other answer", async () => {
    coreSessionStatusMock.mockResolvedValue(session);
    stubServer(404);
    expect((await getDaemonStatus(dataDirWithRecord("chat"), 19091)).healthy).toBe(true);
  });

  it("checks the embedding session's key the same way", async () => {
    coreSessionStatusMock.mockResolvedValue({ ...session, port: 19092, is_embedding: true });
    stubServer(403);
    const status = await getEmbeddingDaemonStatus(dataDirWithRecord("embedding"), 19092, null);
    expect(status).toMatchObject({ running: true, healthy: false, authMismatch: true });
  });
});
