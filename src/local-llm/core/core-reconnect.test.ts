import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectCore, CoreChangedError, isCoreChanged } from "./core-client.js";
import { CoreUnavailableError } from "./core-errors.js";
import { CORE_PROTOCOL, CORE_VERSION, coreDataDir } from "./core-state.js";

/* ATO-1233: a Core that answers for another folder, or one that changed under the lock. */
let root: string;
let server: Server;
let answers: Array<{ instance_id: string; data_folder: string }>;
let port: number;

function writeLock(instanceId: string): void {
  const data = coreDataDir(root, CORE_VERSION);
  mkdirSync(join(data, "atomic-core"), { recursive: true });
  writeFileSync(join(data, "atomic-core", "instance.lock"), JSON.stringify({
    state: "ready", instance_id: instanceId, version: CORE_VERSION, protocol: CORE_PROTOCOL,
    data_folder: data, control_host: "127.0.0.1", control_port: port,
  }));
  writeFileSync(join(data, "atomic-core", "control-token"), "token");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "core-reconnect-"));
  answers = [];
  server = createServer((_req, res) => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...a, version: CORE_VERSION, protocol: CORE_PROTOCOL, owner_scope: "cli", sessions: [], clients: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("connectCore after Core changed (ATO-1233)", () => {
  it("a Core serving another folder means this folder's is not running: null, so the caller starts it", async () => {
    writeLock("a");
    answers = [{ instance_id: "a", data_folder: "/some/other/folder" }];
    expect(await connectCore(root, CORE_VERSION)).toBeNull();
  });

  it("a Core that restarted under the lock is reached on the next read", async () => {
    writeLock("a");
    const data = realpathSync(coreDataDir(root, CORE_VERSION));
    answers = [{ instance_id: "b", data_folder: data }, { instance_id: "a", data_folder: data }];
    const client = await connectCore(root, CORE_VERSION);
    expect(client?.instanceId).toBe("a");
  });

  it("a Core that keeps answering as someone else still fails, in words", async () => {
    writeLock("a");
    answers = [{ instance_id: "b", data_folder: realpathSync(coreDataDir(root, CORE_VERSION)) }];
    await expect(connectCore(root, CORE_VERSION)).rejects.toBeInstanceOf(CoreChangedError);
  });

  it("the change is seen through a CoreUnavailableError's cause", () => {
    const wrapped = new CoreUnavailableError({ stage: "start", reasonCode: "unknown", cause: new CoreChangedError("instance") });
    expect(isCoreChanged(wrapped)).toBe(true);
    expect(isCoreChanged(new Error("x"))).toBe(false);
  });
});
