import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Database } from "../../native/load-better-sqlite3.js";

import { ChatDbServiceLookup, ServiceCheck } from "./imessage-service-check.js";
import type { ImsgMessage } from "./imsg-event.js";

const msg = (over: Partial<ImsgMessage> = {}): ImsgMessage => ({
  rowId: 7,
  chatId: 1,
  sender: "+14155551212",
  isFromMe: false,
  isGroup: false,
  text: "hi",
  attachmentCount: 0,
  service: "unknown",
  ...over,
});

function logger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe("ServiceCheck", () => {
  it("passes a message the stream already proved to be iMessage, without a lookup", () => {
    const lookup = vi.fn(() => "SMS");
    expect(new ServiceCheck({ lookup, logger: logger() as never }).isIMessage(msg({ service: "iMessage" }))).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never looks up a message the stream marked SMS or RCS", () => {
    const lookup = vi.fn(() => "iMessage");
    const check = new ServiceCheck({ lookup, logger: logger() as never });
    expect(check.isIMessage(msg({ service: "SMS" }))).toBe(false);
    expect(check.isIMessage(msg({ service: "RCS" }))).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("asks chat.db by rowid when unknown and accepts only iMessage", () => {
    const lookup = vi.fn((rowId: number) => (rowId === 7 ? "iMessage" : "SMS"));
    const check = new ServiceCheck({ lookup, logger: logger() as never });
    expect(check.isIMessage(msg())).toBe(true);
    expect(lookup).toHaveBeenCalledWith(7);
    expect(check.isIMessage(msg({ rowId: 8 }))).toBe(false);
    expect(new ServiceCheck({ lookup: () => null, logger: logger() as never }).isIMessage(msg())).toBe(false);
  });

  it("refuses when there is no lookup or it throws, logging the failure once", () => {
    expect(new ServiceCheck({ logger: logger() as never }).isIMessage(msg())).toBe(false);
    const log = logger();
    const check = new ServiceCheck({
      lookup: () => {
        throw new Error("unable to open database file");
      },
      logger: log as never,
    });
    expect(check.isIMessage(msg())).toBe(false);
    expect(check.isIMessage(msg())).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).toMatch(/Full Disk Access/);
  });
});

describe("ChatDbServiceLookup", () => {
  it("reads message.service by rowid from a read-only connection it reuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "imessage-chatdb-"));
    try {
      const path = join(dir, "chat.db");
      const seed = new Database(path);
      seed.exec("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, service TEXT)");
      seed.prepare("INSERT INTO message (ROWID, service) VALUES (?, ?)").run(7, "iMessage");
      seed.prepare("INSERT INTO message (ROWID, service) VALUES (?, ?)").run(8, "SMS");
      seed.close();
      const lookup = new ChatDbServiceLookup(path);
      expect(lookup.lookup(7)).toBe("iMessage");
      expect(lookup.lookup(8)).toBe("SMS");
      expect(lookup.lookup(9)).toBeNull();
      lookup.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for a missing database instead of creating one", () => {
    const lookup = new ChatDbServiceLookup("/nonexistent-dir/chat.db");
    expect(() => lookup.lookup(1)).toThrow();
    lookup.close();
    lookup.close();
  });
});
