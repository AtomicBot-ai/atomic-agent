import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatGptExportFixture } from "./chatgpt-export.fixture.js";
import { ChatExportReadError, readChatExport } from "./read-chat-export.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-export-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EXPORT = JSON.stringify(chatGptExportFixture(["I work as a nurse in Lisbon and want short answers"]));

describe("readChatExport (ATO-1617)", () => {
  it("reads a ChatGPT export folder", async () => {
    writeFileSync(join(dir, "conversations.json"), EXPORT);
    const chats = await readChatExport("chatgpt", dir);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.messages[0]).toMatchObject({ role: "user", text: "I work as a nurse in Lisbon and want short answers" });
  });

  it("reads a ChatGPT export zip with the file one folder down", async () => {
    const zip = new JSZip();
    zip.file("export-2026/conversations.json", EXPORT);
    const file = join(dir, "export.zip");
    writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
    expect(await readChatExport("chatgpt", file)).toHaveLength(1);
  });

  it("says what is wrong with a wrong file", async () => {
    await expect(readChatExport("chatgpt", join(dir, "nope.zip"))).rejects.toThrow(ChatExportReadError);
    const notZip = join(dir, "x.zip");
    writeFileSync(notZip, "hello");
    await expect(readChatExport("chatgpt", notZip)).rejects.toThrow(/not a zip/);
    mkdirSync(join(dir, "empty"));
    await expect(readChatExport("chatgpt", join(dir, "empty"))).rejects.toThrow(/no conversations\.json/);
    writeFileSync(join(dir, "conversations.json"), '{"a":1}');
    await expect(readChatExport("chatgpt", dir)).rejects.toThrow(/not a ChatGPT export/);
  });
});
