import { describe, expect, it } from "vitest";

import { LineSplitter, parseImsgLine } from "./imsg-event.js";

/** Shape documented in imsg docs/json.md ("Message"). */
const inbound = {
  id: 9001,
  chat_id: 42,
  chat_identifier: "+14155551212",
  guid: "A1B2",
  sender: "+14155551212",
  is_from_me: false,
  is_group: false,
  text: "list my downloads",
  created_at: "2026-11-12T10:00:00Z",
  attachments: [],
};

describe("parseImsgLine", () => {
  it("reads a new inbound message", () => {
    expect(parseImsgLine(JSON.stringify(inbound))).toEqual({
      rowId: 9001,
      chatId: 42,
      sender: "+14155551212",
      isFromMe: false,
      isGroup: false,
      text: "list my downloads",
      attachmentCount: 0,
    });
  });

  it("keeps is_from_me so the channel can skip its own replies", () => {
    expect(parseImsgLine(JSON.stringify({ ...inbound, is_from_me: true }))?.isFromMe).toBe(true);
  });

  it("counts attachments", () => {
    const line = JSON.stringify({ ...inbound, attachments: [{ filename: "a.png" }] });
    expect(parseImsgLine(line)?.attachmentCount).toBe(1);
  });

  it("drops edits, unsends and tapbacks", () => {
    expect(parseImsgLine(JSON.stringify({ ...inbound, type: "edited" }))).toBeNull();
    expect(parseImsgLine(JSON.stringify({ ...inbound, type: "unsent" }))).toBeNull();
    expect(parseImsgLine(JSON.stringify({ ...inbound, is_reaction: true }))).toBeNull();
  });

  it("drops lines that are not a message", () => {
    expect(parseImsgLine("")).toBeNull();
    expect(parseImsgLine("warning: contacts unavailable")).toBeNull();
    expect(parseImsgLine("{not json")).toBeNull();
    expect(parseImsgLine("[]")).toBeNull();
    expect(parseImsgLine(JSON.stringify({ ...inbound, id: "9001" }))).toBeNull();
    expect(parseImsgLine(JSON.stringify({ ...inbound, chat_id: 0 }))).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const parsed = parseImsgLine(JSON.stringify({ id: 1, chat_id: 2 }));
    expect(parsed).toEqual({
      rowId: 1,
      chatId: 2,
      sender: "",
      isFromMe: false,
      isGroup: false,
      text: "",
      attachmentCount: 0,
    });
  });
});

describe("LineSplitter", () => {
  it("joins lines split across chunks", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.push('{"a":1}\n{"b"');
    splitter.push(':2}\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("drops a runaway line instead of buffering forever", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l), 8);
    splitter.push("0123456789");
    splitter.push("ok\n");
    expect(lines).toEqual(["ok"]);
  });
});
