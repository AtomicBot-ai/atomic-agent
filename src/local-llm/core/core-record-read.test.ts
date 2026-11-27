import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_VERSION, coreSessionPath } from "./core-state.js";
import { coreRecordClaimsPort, readCoreRecordSettled } from "./core-record-read.js";
import { refreshCoreKeyForUrl } from "./core-sessions.js";

/**
 * ATO-2460: on Windows a Core session record that is there can fail to read
 * for a moment. The 401 that follows must still find Core's current key,
 * and must not be read as another program on the port.
 */
let dir: string;
const record = {
  pid: 4242, port: 19091, model_id: "test", model_path: "/test.gguf", is_embedding: false,
  api_key: "stale-key", provider: "llamacpp", generation: "g1", coreVersion: CORE_VERSION, instanceId: "owned",
};

function put(role: "chat" | "embedding", text: string): string {
  const path = coreSessionPath(dir, role);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-record-read-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCoreRecordSettled", () => {
  it("reads a record that did not read at first once it does", async () => {
    const path = put("chat", "");
    const pause = vi.fn(async () => { writeFileSync(path, JSON.stringify(record)); });
    await expect(readCoreRecordSettled(path, pause)).resolves.toMatchObject({ port: 19091, api_key: "stale-key" });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few reads, and never waits for a record that is not there", async () => {
    const pause = vi.fn(async () => {});
    await expect(readCoreRecordSettled(put("chat", "{not json"), pause)).resolves.toBeNull();
    expect(pause).toHaveBeenCalledTimes(3);
    pause.mockClear();
    await expect(readCoreRecordSettled(coreSessionPath(dir, "embedding"), pause)).resolves.toBeNull();
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("refreshCoreKeyForUrl with a record that did not read at first", () => {
  it("still asks Core for the session's current key (null without the re-read)", async () => {
    const path = put("chat", "");
    setTimeout(() => writeFileSync(path, JSON.stringify(record)), 20);
    const status = vi.fn(async () => ({ ...record, api_key: "current-key" }));
    await expect(refreshCoreKeyForUrl(dir, "http://127.0.0.1:19091/completion", status as never)).resolves.toBe("current-key");
    expect(status).toHaveBeenCalledWith(dir, "chat");
  });
});

describe("coreRecordClaimsPort", () => {
  it("is true for a record naming the port, in either role", () => {
    put("embedding", JSON.stringify({ ...record, is_embedding: true }));
    expect(coreRecordClaimsPort(dir, 19091)).toBe(true);
  });

  it("is true for a record that is there and does not read", () => {
    put("chat", "{half");
    expect(coreRecordClaimsPort(dir, 19091)).toBe(true);
  });

  it("is false for a record naming another port, or no record at all", () => {
    expect(coreRecordClaimsPort(dir, 19091)).toBe(false);
    put("chat", JSON.stringify({ ...record, port: 19999 }));
    expect(coreRecordClaimsPort(dir, 19091)).toBe(false);
  });
});
