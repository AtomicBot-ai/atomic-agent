/**
 * `/cron` through `handleInboundText` (ATO-21): the owner gate in front
 * of the command, and the dispatch to it. The subcommands themselves are
 * covered in cron-command.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { TaskStore } from "../../tasks/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";

import { handleInboundText, type InboundContext } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

const OWNER = 42;
const STRANGER = 99;
const CHAT = 100;

describe("/cron over Telegram", () => {
  let dir: string;
  let store: TaskStore;
  let sent: string[];
  let ctx: InboundContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-cron-"));
    store = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
    store.create({
      id: "t-1a2b3c4d-0000",
      sessionId: "s-1",
      userMessage: "morning digest",
      origin: "telegram",
      maxAttempts: 3,
      schedule: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      scheduledFor: Date.UTC(2030, 0, 1, 9, 0),
    });
    sent = [];
    const api = {
      sendMessage: vi.fn(async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: sent.length };
      }),
      sendChatAction: vi.fn(async () => undefined),
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
    } as unknown as TelegramApi;
    const runtime = {
      taskStore: store,
      taskRunner: { create: vi.fn(), cancel: vi.fn() },
      scheduler: {},
    } as unknown as AgentRuntime;
    ctx = {
      runtime,
      api,
      sessionPointer: new TelegramSessionPointer(join(dir, "telegram-session.json")),
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      inflight: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function update(text: string, fromId: number) {
    return { from: { id: fromId }, chat: { id: CHAT, type: "private" }, text, message_id: 1 };
  }

  it("lists the owner's scheduled tasks", async () => {
    await handleInboundText(update("/cron", OWNER), ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Scheduled tasks (1):");
    expect(sent[0]).toContain("t-1a2b3c4d");
  });

  it("drops /cron from anyone else without a reply or a change", async () => {
    await handleInboundText(update("/cron delete t-1a2b3c4d", STRANGER), ctx);
    expect(sent).toHaveLength(0);
    expect(store.get("t-1a2b3c4d-0000")!.status).toBe("pending");
  });

  it("pauses from the chat", async () => {
    await handleInboundText(update("/cron pause 1a2b3c4d", OWNER), ctx);
    expect(sent[0]).toContain("Paused t-1a2b3c4d");
    expect(store.get("t-1a2b3c4d-0000")!.status).toBe("paused");
    expect(store.listDue(Date.UTC(2031, 0, 1))).toHaveLength(0);
    sent.length = 0;
    await handleInboundText(update("/cron", OWNER), ctx);
    expect(sent[0]).toContain("· Paused");
  });

  it("lists /cron in /help", async () => {
    await handleInboundText(update("/help", OWNER), ctx);
    expect(sent[0]).toContain("/cron");
  });
});
