import { describe, expect, it } from "vitest";

import {
  ImapProtocolError,
  ImapResponseReader,
  quoteImapString,
  responseCode,
} from "./imap-response.js";

function feedBytewise(reader: ImapResponseReader, text: string) {
  const out = [];
  for (const byte of Buffer.from(text, "latin1")) out.push(...reader.push(Buffer.from([byte])));
  return out;
}

describe("ImapResponseReader (ATO-601)", () => {
  it("splits tagged, untagged and continuation lines", () => {
    const reader = new ImapResponseReader(1024);
    const out = reader.push(Buffer.from("* OK ready\r\n+ idling\r\nA1 OK done\r\n"));
    expect(out.map((r) => [r.tag, r.text])).toEqual([
      ["*", "OK ready"],
      ["+", "idling"],
      ["A1", "OK done"],
    ]);
  });

  it("keeps literal bytes apart from the line, even split byte by byte", () => {
    const reader = new ImapResponseReader(1024);
    const body = "Subject: hi\r\n\r\nline one\r\nA9 OK fake tag inside the literal\r\n";
    const wire = `* 1 FETCH (UID 7 BODY[] {${Buffer.byteLength(body)}}\r\n${body})\r\nA2 OK fetched\r\n`;
    const out = feedBytewise(reader, wire);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe(`1 FETCH (UID 7 BODY[] {${Buffer.byteLength(body)}})`);
    expect(out[0]!.literals[0]!.toString("latin1")).toBe(body);
    expect(out[1]).toMatchObject({ tag: "A2", text: "OK fetched" });
  });

  it("reads a zero-length literal and several literals in one response", () => {
    const reader = new ImapResponseReader(1024);
    const out = reader.push(Buffer.from("* 1 FETCH (A {0}\r\n B {3}\r\nxyz)\r\n"));
    expect(out[0]!.literals.map((b) => b.toString())).toEqual(["", "xyz"]);
  });

  it("refuses a literal over the limit and an endless line", () => {
    expect(() => new ImapResponseReader(10).push(Buffer.from("* 1 FETCH (BODY[] {11}\r\n"))).toThrow(ImapProtocolError);
    expect(() => new ImapResponseReader(10).push(Buffer.alloc(1024 * 1024 + 1, 0x41))).toThrow(ImapProtocolError);
  });

  it("reads response codes and quotes strings", () => {
    expect(responseCode("OK [UIDVALIDITY 3857529045] UIDs valid")).toEqual({ code: "UIDVALIDITY", args: "3857529045" });
    expect(responseCode("OK [READ-WRITE] done")).toEqual({ code: "READ-WRITE", args: "" });
    expect(responseCode("OK plain")).toBeNull();
    expect(quoteImapString('pa"ss\\word')).toBe('"pa\\"ss\\\\word"');
    expect(() => quoteImapString("a\r\nA2 LOGOUT")).toThrow();
  });
});
