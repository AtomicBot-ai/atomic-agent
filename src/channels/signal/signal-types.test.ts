import { describe, expect, it } from "vitest";

import {
  SIGNAL_DEFAULT_URL,
  chatKeyOf,
  extractEnvelope,
  normalizeSignalId,
  readSignalOptions,
  scrubSignalError,
  toInbound,
} from "./signal-types.js";

const cfg = (options: Record<string, string | number | boolean>) => ({
  enabled: true,
  ownerIds: [],
  options,
});

describe("readSignalOptions", () => {
  it("defaults the url and reads a missing account as null", () => {
    expect(readSignalOptions(cfg({}))).toEqual({
      url: SIGNAL_DEFAULT_URL,
      account: null,
      allowGroups: false,
    });
  });

  it("trims a trailing slash, normalizes the account, reads allowGroups", () => {
    const o = readSignalOptions(
      cfg({ url: "http://127.0.0.1:9090/", account: "+1 (555) 000-1111", allowGroups: true }),
    );
    expect(o).toEqual({ url: "http://127.0.0.1:9090", account: "+15550001111", allowGroups: true });
  });

  it("ignores wrong types instead of throwing", () => {
    expect(readSignalOptions(cfg({ url: 5, account: true, allowGroups: "yes" }))).toEqual({
      url: SIGNAL_DEFAULT_URL,
      account: null,
      allowGroups: false,
    });
  });
});

describe("normalizeSignalId", () => {
  it("canonicalizes numbers and lower-cases UUIDs", () => {
    expect(normalizeSignalId(" +44 20 7946 0000 ")).toBe("+442079460000");
    expect(normalizeSignalId("ABCDEF12-3456-4789-8ABC-DEF012345678")).toBe(
      "abcdef12-3456-4789-8abc-def012345678",
    );
  });
});

describe("extractEnvelope", () => {
  const envelope = { sourceNumber: "+15550002222", dataMessage: { message: "hi" } };

  it("reads the SSE shape and the JSON-RPC notification shapes", () => {
    expect(extractEnvelope({ envelope, account: "+15550001111" })).toEqual({
      envelope,
      account: "+15550001111",
    });
    expect(extractEnvelope({ method: "receive", params: { envelope } })?.envelope).toBe(envelope);
    expect(extractEnvelope({ params: { subscription: 0, result: { envelope } } })?.envelope).toBe(
      envelope,
    );
  });

  it("returns null for anything else", () => {
    expect(extractEnvelope(null)).toBeNull();
    expect(extractEnvelope({ jsonrpc: "2.0", result: {} })).toBeNull();
  });
});

describe("toInbound", () => {
  it("reads a DM text message", () => {
    const msg = toInbound({
      source: "+15550002222",
      sourceNumber: "+15550002222",
      sourceUuid: "AAAAAAAA-1111-4111-8111-111111111111",
      sourceName: "Ada",
      dataMessage: { message: "deploy please" },
    });
    expect(msg).toEqual({
      senderIds: ["+15550002222", "aaaaaaaa-1111-4111-8111-111111111111"],
      replyTo: "+15550002222",
      senderName: "Ada",
      text: "deploy please",
      groupId: null,
      attachmentCount: 0,
    });
    expect(chatKeyOf(msg!)).toBe("dm:+15550002222");
  });

  it("falls back to the UUID for a sender without a number", () => {
    const msg = toInbound({
      sourceUuid: "bbbbbbbb-1111-4111-8111-111111111111",
      dataMessage: { message: "hi" },
    });
    expect(msg?.replyTo).toBe("bbbbbbbb-1111-4111-8111-111111111111");
  });

  it("keys group messages by group id", () => {
    const msg = toInbound({
      sourceNumber: "+15550002222",
      dataMessage: { message: "hi", groupInfo: { groupId: "R3JvdXA=" } },
    });
    expect(msg?.groupId).toBe("R3JvdXA=");
    expect(chatKeyOf(msg!)).toBe("group:R3JvdXA=");
  });

  it("ignores receipts, typing, sync messages and empty bodies", () => {
    expect(toInbound({ sourceNumber: "+15550002222" })).toBeNull();
    expect(toInbound({ sourceNumber: "+15550002222", dataMessage: { message: "  " } })).toBeNull();
    expect(toInbound({ dataMessage: { message: "no sender" } })).toBeNull();
  });
});

describe("scrubSignalError", () => {
  it("redacts long opaque blobs and credential pairs", () => {
    const out = scrubSignalError(new Error(`token=abc123 ${"x".repeat(50)}`));
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("x".repeat(50));
  });
});
