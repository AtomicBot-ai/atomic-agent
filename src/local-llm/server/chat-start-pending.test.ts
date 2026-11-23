import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_START_PENDING_STALE_MS,
  chatStartPending,
  chatStartPendingPath,
  markChatStartPending,
  withChatStartPending,
} from "./chat-start-pending.js";

describe("chat start pending marker (ATO-421)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "chat-start-pending-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
  const longUp = { bootTimeMs: () => 0 };

  it("is written as a start begins and removed as it ends", () => {
    expect(chatStartPending(dataDir, longUp)).toBe(false);
    const done = markChatStartPending(dataDir);
    expect(readFileSync(chatStartPendingPath(dataDir), "utf8")).toBe(String(process.pid));
    expect(chatStartPending(dataDir, longUp)).toBe(true);
    done();
    expect(existsSync(chatStartPendingPath(dataDir))).toBe(false);
    expect(chatStartPending(dataDir, longUp)).toBe(false);
  });

  it("is removed when the start throws", async () => {
    await expect(withChatStartPending(dataDir, async () => { throw new Error("load failed"); })).rejects.toThrow("load failed");
    expect(existsSync(chatStartPendingPath(dataDir))).toBe(false);
  });

  it("nested marks in one process keep the marker until the outermost ends", () => {
    const outer = markChatStartPending(dataDir);
    const inner = markChatStartPending(dataDir);
    inner();
    expect(chatStartPending(dataDir, longUp)).toBe(true);
    inner();
    expect(chatStartPending(dataDir, longUp)).toBe(true);
    outer();
    expect(chatStartPending(dataDir, longUp)).toBe(false);
  });

  it("never removes another starter's marker", () => {
    const done = markChatStartPending(dataDir);
    writeFileSync(chatStartPendingPath(dataDir), "4242");
    done();
    expect(readFileSync(chatStartPendingPath(dataDir), "utf8")).toBe("4242");
  });

  it("a marker another live process holds counts; a gone owner's does not", () => {
    writeFileSync(chatStartPendingPath(dataDir), "4242");
    expect(chatStartPending(dataDir, { ...longUp, pidLiveness: () => "alive" })).toBe(true);
    writeFileSync(chatStartPendingPath(dataDir), String(deadPid()));
    expect(chatStartPending(dataDir, longUp)).toBe(false);
  });

  it("this process's own leftover marker counts only while it holds a start", () => {
    writeFileSync(chatStartPendingPath(dataDir), String(process.pid));
    expect(chatStartPending(dataDir, longUp)).toBe(false);
  });

  it("a marker older than the stale bound, or from before the last boot, is no start", () => {
    writeFileSync(chatStartPendingPath(dataDir), "4242");
    const alive = { pidLiveness: () => "alive" as const };
    const old = (Date.now() - CHAT_START_PENDING_STALE_MS - 60_000) / 1000;
    utimesSync(chatStartPendingPath(dataDir), old, old);
    expect(chatStartPending(dataDir, { ...longUp, ...alive })).toBe(false);
    writeFileSync(chatStartPendingPath(dataDir), "4242");
    expect(chatStartPending(dataDir, { ...alive, bootTimeMs: () => Date.now() + 120_000 })).toBe(false);
  });

  it("an empty marker counts only while it is fresh", () => {
    writeFileSync(chatStartPendingPath(dataDir), "");
    expect(chatStartPending(dataDir, longUp)).toBe(true);
    expect(chatStartPending(dataDir, { ...longUp, now: () => Date.now() + 60_000 })).toBe(false);
  });
});
