import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import JSZip from "jszip";

import { ClaudeAppSource } from "../claude-app/claude-app-source.js";

import { parseChatGptConversations } from "./chatgpt-export.js";
import { chatsFromClaudeApp, type ChatExportSource, type ExportChat } from "./collect-user-messages.js";

/**
 * Read the chats of a ChatGPT or Claude data export, as downloaded (the
 * `.zip`) or unpacked (its folder), for the facts import (ATO-1617).
 *
 * - Claude: the existing {@link ClaudeAppSource} reader, so the facts
 *   step reads the export exactly as the chats import did.
 * - ChatGPT: `conversations.json` found by name (it may sit one folder
 *   down in the zip), parsed by {@link parseChatGptConversations}.
 *
 * Nothing is written and no message text is logged.
 */
export class ChatExportReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatExportReadError";
  }
}

export async function readChatExport(source: ChatExportSource, path: string): Promise<ExportChat[]> {
  if (!existsSync(path)) throw new ChatExportReadError(`no such file or folder: ${path}`);
  if (source === "claude") {
    const loaded = await new ClaudeAppSource(path).load();
    return chatsFromClaudeApp(loaded.conversations);
  }
  const text = await readConversationsJson(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ChatExportReadError("conversations.json is not valid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new ChatExportReadError("conversations.json is not a ChatGPT export (expected a list of chats)");
  }
  return parseChatGptConversations(raw);
}

async function readConversationsJson(path: string): Promise<string> {
  if (statSync(path).isDirectory()) {
    const file = join(path, "conversations.json");
    if (existsSync(file)) return readFileSync(file, "utf8");
    throw missing(path);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(readFileSync(path));
  } catch {
    throw new ChatExportReadError(`${basename(path)} is not a zip (expected the ChatGPT data export .zip or its folder)`);
  }
  // The top-level file wins over one a folder down; anything deeper is not the export's.
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && basename(e.name) === "conversations.json" && e.name.split("/").length <= 2)
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  const entry = entries[0];
  if (!entry) throw missing(path);
  return entry.async("string");
}

function missing(path: string): ChatExportReadError {
  return new ChatExportReadError(
    `no conversations.json in ${path} (expected the ChatGPT data export: Settings › Data controls › Export data)`,
  );
}
