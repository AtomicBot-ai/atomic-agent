import { describe, expect, it } from "vitest";

import { parseConversations } from "../claude-app/claude-app-source.js";
import { parseChatGptConversations } from "./chatgpt-export.js";
import {
  chatsFromClaudeApp,
  collectUserMessages,
  isTrivialUserMessage,
  type ExportChat,
} from "./collect-user-messages.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/* A Claude export cut down to the fields read (values made up): 3 chats. */
const CLAUDE_EXPORT = [
  {
    uuid: "chat-new",
    name: "Portfolio",
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:05:00Z",
    chat_messages: [
      {
        sender: "human",
        text: "I'm a product designer from Berlin, help me with my portfolio",
        content: [{ type: "text", text: "I'm a product designer from Berlin, help me with my portfolio" }],
        created_at: "2026-11-01T09:00:00Z",
        attachments: [{ file_name: "cv.pdf", extracted_content: "SECRET CV TEXT" }],
      },
      {
        sender: "assistant",
        text: "Sure, as a designer you should...",
        content: [
          { type: "thinking", thinking: "the user lives in Berlin" },
          { type: "text", text: "Sure, as a designer you should..." },
        ],
        created_at: "2026-11-01T09:00:10Z",
      },
      { sender: "human", text: "thanks!", created_at: "2026-11-01T09:01:00Z" },
    ],
  },
  {
    uuid: "chat-mid",
    name: "Keys",
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-06-01T09:00:00Z",
    chat_messages: [
      {
        sender: "human",
        text: "My OpenRouter key is sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef why does it fail",
        created_at: "2026-06-01T09:00:00Z",
      },
    ],
  },
  {
    uuid: "chat-old",
    name: "Old",
    created_at: "2024-01-01T09:00:00Z",
    updated_at: "2024-01-01T09:00:00Z",
    chat_messages: [
      { sender: "human", text: "I used to live in Lisbon back then", created_at: "2024-01-01T09:00:00Z" },
    ],
  },
];

function claudeChats(): ExportChat[] {
  return chatsFromClaudeApp(parseConversations(CLAUDE_EXPORT));
}

describe("collectUserMessages (ATO-1620)", () => {
  it("keeps only the person's own words: no replies, reasoning or attachment text", () => {
    const { chunks, stats } = collectUserMessages(claudeChats(), { nowMs: NOW });
    const texts = chunks.flatMap((c) => c.messages.map((m) => m.text));
    const all = texts.join("\n");
    expect(all).toContain("product designer from Berlin");
    expect(all).not.toContain("Sure, as a designer");
    expect(all).not.toContain("the user lives in Berlin");
    expect(all).not.toContain("SECRET CV TEXT");
    expect(stats.chats).toBe(3);
    expect(stats.userMessages).toBe(4);
  });

  it("drops trivial replies", () => {
    const { stats, chunks } = collectUserMessages(claudeChats(), { nowMs: NOW });
    expect(stats.droppedTrivial).toBe(1);
    expect(chunks.flatMap((c) => c.messages).some((m) => m.text === "thanks!")).toBe(false);
  });

  it("applies the 12-month default window", () => {
    const { stats, chunks } = collectUserMessages(claudeChats(), { nowMs: NOW });
    expect(stats.droppedOld).toBe(1);
    expect(chunks.flatMap((c) => c.messages).some((m) => m.chatId === "chat-old")).toBe(false);
  });

  it("monthsBack 0 lifts the date window", () => {
    const { stats } = collectUserMessages(claudeChats(), { nowMs: NOW, monthsBack: 0 });
    expect(stats.droppedOld).toBe(0);
    expect(stats.kept).toBe(3);
  });

  it("masks a pasted key before it can reach a model", () => {
    const { chunks } = collectUserMessages(claudeChats(), { nowMs: NOW });
    const all = chunks.flatMap((c) => c.messages.map((m) => m.text)).join("\n");
    expect(all).not.toContain("sk-or-v1-0123456789abcdef");
    expect(all).toContain("[redacted:");
  });

  it("keeps the newest messages when over the limit, newest chunk first", () => {
    const chat: ExportChat = {
      id: "many",
      messages: Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        text: `Message number ${i} about my garden project`,
        atMs: NOW - (10 - i) * DAY,
      })),
    };
    const { chunks, stats } = collectUserMessages([chat], { nowMs: NOW, maxMessages: 4, chunkChars: 80 });
    expect(stats.kept).toBe(4);
    expect(stats.droppedOverLimit).toBe(6);
    const texts = chunks.flatMap((c) => c.messages.map((m) => m.text));
    expect(texts[0]).toContain("number 9");
    expect(texts.some((t) => t.includes("number 5"))).toBe(false);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c, i) => c.index === i && c.chatIds.includes("many"))).toBe(true);
  });

  it("stats carry numbers only", () => {
    const { stats } = collectUserMessages(claudeChats(), { nowMs: NOW });
    for (const v of Object.values(stats)) expect(typeof v).toBe("number");
  });
});

describe("isTrivialUserMessage", () => {
  it.each(["ok", "Спасибо!", "  ", "да", "?", "lol 1"])("%s is trivial", (t) => {
    expect(isTrivialUserMessage(t)).toBe(true);
  });
  it.each(["I work as a nurse", "Я живу в Тбилиси"])("%s is kept", (t) => {
    expect(isTrivialUserMessage(t)).toBe(false);
  });
});

describe("parseChatGptConversations", () => {
  const EXPORT = [
    {
      conversation_id: "gpt-1",
      title: "Trip",
      create_time: NOW / 1000 - 5 * 86400,
      current_node: "a2",
      mapping: {
        root: { id: "root", parent: null, children: ["sys"], message: null },
        sys: {
          id: "sys",
          parent: "root",
          children: ["u1"],
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["custom instructions"] },
            metadata: { is_visually_hidden_from_conversation: true },
          },
        },
        u1: {
          id: "u1",
          parent: "sys",
          children: ["a1"],
          message: {
            author: { role: "user" },
            create_time: NOW / 1000 - 5 * 86400,
            content: { content_type: "text", parts: ["I am vegetarian, plan my trip to Rome"] },
          },
        },
        a1: {
          id: "a1",
          parent: "u1",
          children: ["u2-old", "u2"],
          message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Here is a plan"] } },
        },
        "u2-old": {
          id: "u2-old",
          parent: "a1",
          children: [],
          message: { author: { role: "user" }, content: { content_type: "text", parts: ["abandoned edit text"] } },
        },
        u2: {
          id: "u2",
          parent: "a1",
          children: ["a2"],
          message: {
            author: { role: "user" },
            content: { content_type: "multimodal_text", parts: [{ asset_pointer: "file://x" }, "And this photo is my dog"] },
          },
        },
        a2: {
          id: "a2",
          parent: "u2",
          children: [],
          message: { author: { role: "assistant" }, content: { content_type: "code", text: "x" } },
        },
      },
    },
    { title: "no id", mapping: {} },
  ];

  it("reads the visible branch only, skipping hidden and non-text messages", () => {
    const chats = parseChatGptConversations(EXPORT);
    expect(chats).toHaveLength(1);
    const texts = chats[0]!.messages.map((m) => `${m.role}:${m.text}`);
    expect(texts).toEqual([
      "user:I am vegetarian, plan my trip to Rome",
      "assistant:Here is a plan",
      "user:And this photo is my dog",
    ]);
  });

  it("feeds collectUserMessages", () => {
    const { stats } = collectUserMessages(parseChatGptConversations(EXPORT), { nowMs: NOW });
    expect(stats.kept).toBe(2);
  });

  it("is safe on junk", () => {
    expect(parseChatGptConversations(null)).toEqual([]);
    expect(parseChatGptConversations([1, "x", { id: "a" }])).toEqual([]);
  });
});
