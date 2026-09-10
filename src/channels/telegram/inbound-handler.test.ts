import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  createEmptySessionState,
  type SessionState,
} from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { createAttachmentInbox } from "../attachments/inbox.js";
import {
  handleInboundFile,
  handleInboundText,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  type InboundContext,
  type InboundTextUpdate,
} from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import type { InboundFileUpdate } from "./telegram-file-update.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

interface RunTurnCall {
  sessionId: string;
  userMessage: string;
  origin: string | undefined;
  events: AgentLoopEvent[];
}

interface FakeRuntimeOpts {
  /** Sequence of event scripts; each script fires events into the hook then resolves. */
  scripts?: ReadonlyArray<{
    events: AgentLoopEvent[];
    /** Optionally throw after firing events. */
    error?: Error;
  }>;
  initialSessions?: SessionState[];
}

function makeFakeRuntime(opts: FakeRuntimeOpts = {}): {
  runtime: AgentRuntime;
  calls: RunTurnCall[];
  sessions: SessionState[];
  abortRequests: AbortSignal[];
} {
  const calls: RunTurnCall[] = [];
  const sessions: SessionState[] = [...(opts.initialSessions ?? [])];
  const abortRequests: AbortSignal[] = [];
  let scriptCursor = 0;
  let idCounter = 1;
  const busy = new Set<string>();

  const runtime = {
    createSession: (input?: { metadata?: Record<string, unknown> }) => {
      const id = `s-${idCounter++}`;
      const session = createEmptySessionState({
        id,
        workingDir: "/tmp/test",
        ...(input?.metadata ? { metadata: input.metadata } : {}),
      });
      sessions.push(session);
      return session;
    },
    sessionStore: {
      load: (id: string) => sessions.find((s) => s.id === id) ?? null,
    },
    turnController: {
      isBusy: (id: string) => busy.has(id),
    },
    runTurn: async (
      session: SessionState,
      userMessage: string,
      runOpts?: {
        eventHook?: (e: AgentLoopEvent) => void;
        signal?: AbortSignal;
        origin?: string;
      },
    ) => {
      const events: AgentLoopEvent[] = [];
      const call: RunTurnCall = {
        sessionId: session.id,
        userMessage,
        origin: runOpts?.origin,
        events,
      };
      calls.push(call);
      if (runOpts?.signal) abortRequests.push(runOpts.signal);
      const script = opts.scripts?.[scriptCursor++];
      if (script) {
        for (const event of script.events) {
          events.push(event);
          runOpts?.eventHook?.(event);
        }
        if (script.error) throw script.error;
      }
      return { session, reason: "reply" as const, stepCount: 1 };
    },
  } as unknown as AgentRuntime;

  return { runtime, calls, sessions, abortRequests };
}

interface FakeApi extends TelegramApi {
  sent: Array<{
    chatId: number;
    text: string;
    opts?: Record<string, unknown> | undefined;
  }>;
  typingChats: number[];
  typing: Array<{ chatId: number; opts?: Record<string, unknown> | undefined }>;
  edits: Array<{ chatId: number; messageId: number; text: string }>;
  deletes: Array<{ chatId: number; messageId: number }>;
}

function makeFakeApi(): FakeApi {
  const sent: Array<{
    chatId: number;
    text: string;
    opts?: Record<string, unknown> | undefined;
  }> = [];
  const typingChats: number[] = [];
  const typing: Array<{
    chatId: number;
    opts?: Record<string, unknown> | undefined;
  }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  return {
    sent,
    typingChats,
    typing,
    edits,
    deletes,
    sendMessage: vi.fn(
      async (chatId: number, text: string, opts?: Record<string, unknown>) => {
        sent.push({ chatId, text, opts });
        return { message_id: sent.length };
      },
    ),
    sendChatAction: vi.fn(
      async (
        chatId: number,
        _action: "typing",
        opts?: Record<string, unknown>,
      ) => {
        typingChats.push(chatId);
        typing.push({ chatId, opts });
        return undefined;
      },
    ),
    editMessageText: vi.fn(
      async (chatId: number, messageId: number, text: string) => {
        edits.push({ chatId, messageId, text });
        return true;
      },
    ),
    deleteMessage: vi.fn(async (chatId: number, messageId: number) => {
      deletes.push({ chatId, messageId });
      return true;
    }),
  };
}

function makeContext(
  runtime: AgentRuntime,
  api: TelegramApi,
  pointer: TelegramSessionPointer,
  ownerUserId: number | null,
  inboxDir: string,
): InboundContext & { inflight: Map<string, AbortController> } {
  return {
    runtime,
    api,
    sessionPointer: pointer,
    logger: new StructuredLogger({ level: "warn", sinks: [] }),
    ownerUserId,
    inflight: new Map(),
    inbox: createAttachmentInbox({ dir: inboxDir }),
    mediaGroups: new Map(),
    scheduleKeepalive: () => () => undefined,
  };
}

const OWNER = 42;
const CHAT = 100;
const CHAT_KEY = String(CHAT);
const NON_OWNER = 99;
const BOT = { id: 7, username: "atomic_bot" };
const GROUP = -1001;

function makeUpdate(
  text: string,
  fromId: number = OWNER,
  chatType: string = "private",
): InboundTextUpdate {
  return {
    from: { id: fromId },
    chat: { id: CHAT, type: chatType },
    text,
    message_id: 1,
  };
}

describe("handleInboundText", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-handler-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops group-chat messages when the bot identity is unknown", async () => {
    // Without `getMe` there is no way to tell whether a group message
    // was addressed to us, so the safe answer is to stay quiet.
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("hello", OWNER, "group"), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("drops broadcast-channel posts", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      botIdentity: BOT,
    };
    await handleInboundText(
      makeUpdate("@atomic_bot hello", OWNER, "channel"),
      ctx,
    );
    expect(calls).toHaveLength(0);
  });

  it("drops messages from non-owner DMs silently", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("hello", NON_OWNER), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("drops messages when ownerUserId is null", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, null, join(dir, "inbox"));
    await handleInboundText(makeUpdate("hello", OWNER), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("/start sends help text and never reaches the runtime", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/start"), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text).toContain("atomic-agent");
    expect(api.sent[0]!.text).toContain("/help");
  });

  it("/help sends help text", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/help"), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent[0]!.text).toContain("/cancel");
  });

  it("/status reports no active session when pointer is empty", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/status"), ctx);
    expect(api.sent[0]!.text).toContain("No active session");
  });

  it("/new rotates this chat's pointer, releases its approvals and acks", async () => {
    pointer.setCurrent(CHAT_KEY, "s-old");
    pointer.setCurrent("200", "s-other");
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const releaseApprovalSession = vi.fn();
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      releaseApprovalSession,
    };
    await handleInboundText(makeUpdate("/new"), ctx);
    expect(pointer.get(CHAT_KEY).current).toBeNull();
    expect(pointer.get(CHAT_KEY).history).toEqual(["s-old"]);
    // Another chat's session is untouched.
    expect(pointer.get("200").current).toBe("s-other");
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-old");
    expect(api.sent[0]!.text).toContain("s-old");
  });

  it("/cancel reports no in-flight when nothing is running", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/cancel"), ctx);
    expect(api.sent[0]!.text).toBe("No turn in progress in this chat.");
  });

  it("/cancel aborts the in-flight controller", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    const ctrl = new AbortController();
    ctx.inflight.set(CHAT_KEY, ctrl);
    await handleInboundText(makeUpdate("/cancel"), ctx);
    expect(ctrl.signal.aborted).toBe(true);
    expect(api.sent[0]!.text).toContain("Cancelling");
  });

  it("dispatches plain text into runTurn with origin=telegram and routes assistant_reply back", async () => {
    const { runtime, calls } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "the sky is blue" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("why is the sky blue?"), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe("why is the sky blue?");
    expect(calls[0]!.origin).toBe("telegram");
    const replyMsg = api.sent.find((m) => m.text === "the sky is blue");
    expect(replyMsg).toBeDefined();
    expect(api.typingChats[0]).toBe(CHAT);
  });

  it("posts the progress bubble silently and deletes it before the reply", async () => {
    const { runtime } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "done" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("do the thing"), ctx);

    // First send is the bubble (silent), second is the reply (audible).
    expect(api.sent[0]!.text).toBe("🤔 Thinking…");
    expect(api.sent[0]!.opts).toMatchObject({ disable_notification: true });
    expect(api.sent[1]!.text).toBe("done");
    expect(api.sent[1]!.opts?.disable_notification).toBeUndefined();
    // The bubble (message_id 1) is removed once the turn settles.
    expect(api.deletes).toEqual([{ chatId: CHAT, messageId: 1 }]);
  });

  it("progressIndicator: false suppresses the bubble entirely", async () => {
    const { runtime } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "done" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    ctx.progressIndicator = false;
    await handleInboundText(makeUpdate("do the thing"), ctx);

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text).toBe("done");
    expect(api.deletes).toHaveLength(0);
    expect(api.edits).toHaveLength(0);
  });

  it("formats loop_failed events as a single error message", async () => {
    const { runtime } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "loop_failed",
              error: new Error("kaboom"),
              category: "transport",
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("do it"), ctx);
    const failureMsg = api.sent.find((m) => m.text.startsWith("Turn failed"));
    expect(failureMsg).toBeDefined();
    expect(failureMsg!.text).toContain("[transport]");
    expect(failureMsg!.text).toContain("kaboom");
  });

  it("creates a fresh session on the first message and persists the pointer", async () => {
    const { runtime, sessions } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "hi" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    expect(pointer.get(CHAT_KEY).current).toBeNull();
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(sessions.length).toBe(1);
    expect(pointer.get(CHAT_KEY).current).toBe(sessions[0]!.id);
    expect(sessions[0]!.metadata).toMatchObject({
      telegramChannel: true,
      telegramChat: { id: CHAT, type: "private", label: "DM" },
    });
  });

  it("reuses the existing session on subsequent messages", async () => {
    const seeded = createEmptySessionState({
      id: "s-existing",
      workingDir: "/tmp/test",
    });
    pointer.setCurrent(CHAT_KEY, seeded.id);
    const { runtime, calls } = makeFakeRuntime({
      initialSessions: [seeded],
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "ok" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(calls[0]!.sessionId).toBe("s-existing");
  });

  it("calls ensureApprovalSession with the active session id and chat id before dispatch", async () => {
    const { runtime, sessions } = makeFakeRuntime({
      scripts: [
        {
          events: [
            {
              type: "llm_event",
              event: { type: "assistant_reply", text: "ok" },
            },
          ],
        },
      ],
    });
    const api = makeFakeApi();
    const ensureApprovalSession = vi.fn();
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      ensureApprovalSession,
    };
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(ensureApprovalSession).toHaveBeenCalledTimes(1);
    expect(ensureApprovalSession).toHaveBeenCalledWith(sessions[0]!.id, {
      chatId: CHAT,
    });
  });

  it("does not call ensureApprovalSession for slash commands", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ensureApprovalSession = vi.fn();
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      ensureApprovalSession,
    };
    await handleInboundText(makeUpdate("/help"), ctx);
    expect(ensureApprovalSession).not.toHaveBeenCalled();
  });

  it("pairing claim consumes the message silently and skips runtime dispatch", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const tryClaimForPairing = vi.fn().mockReturnValue(true);
    const ctx = {
      ...makeContext(runtime, api, pointer, null, join(dir, "inbox")),
      tryClaimForPairing,
    };
    await handleInboundText(makeUpdate("/pair", NON_OWNER), ctx);
    expect(tryClaimForPairing).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("pairing claim wins over the owner check: non-owner DMs are accepted during pairing", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const tryClaimForPairing = vi.fn().mockReturnValue(true);
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      tryClaimForPairing,
    };
    await handleInboundText(makeUpdate("/pair", NON_OWNER), ctx);
    expect(tryClaimForPairing).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("pairing tryClaim returning false falls through to the owner check", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const tryClaimForPairing = vi.fn().mockReturnValue(false);
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      tryClaimForPairing,
    };
    await handleInboundText(makeUpdate("hello", NON_OWNER), ctx);
    expect(tryClaimForPairing).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // dropped by owner check
    expect(api.sent).toHaveLength(0);
  });

  describe("agentReplyParseMode", () => {
    it("renders agent replies as HTML when agentReplyParseMode='html'", async () => {
      const { runtime } = makeFakeRuntime({
        scripts: [
          {
            events: [
              {
                type: "llm_event",
                event: {
                  type: "assistant_reply",
                  text: "**bold** and `code`",
                },
              },
            ],
          },
        ],
      });
      const api = makeFakeApi();
      const ctx = {
        ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
        agentReplyParseMode: "html" as const,
      };
      await handleInboundText(makeUpdate("hello"), ctx);
      const reply = api.sent.find((m) => m.text.includes("<b>bold</b>"));
      expect(reply).toBeDefined();
      expect(reply!.text).toBe("<b>bold</b> and <code>code</code>");
      expect(reply!.opts).toEqual({
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    });

    it("keeps slash-command responses plain even when html is configured", async () => {
      const { runtime } = makeFakeRuntime();
      const api = makeFakeApi();
      const ctx = {
        ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
        agentReplyParseMode: "html" as const,
      };
      await handleInboundText(makeUpdate("/help"), ctx);
      expect(api.sent).toHaveLength(1);
      expect(api.sent[0]!.opts).toBeUndefined();
    });

    it("keeps failure envelopes plain even when html is configured", async () => {
      const { runtime } = makeFakeRuntime({
        scripts: [
          {
            events: [
              {
                type: "loop_failed",
                error: new Error("kaboom <oops>"),
                category: "transport",
              },
            ],
          },
        ],
      });
      const api = makeFakeApi();
      const ctx = {
        ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
        agentReplyParseMode: "html" as const,
      };
      await handleInboundText(makeUpdate("do it"), ctx);
      const failure = api.sent.find((m) => m.text.startsWith("Turn failed"));
      expect(failure).toBeDefined();
      // No parse_mode header — failure metadata stays plain so `<oops>`
      // never gets parsed as an HTML tag.
      expect(failure!.opts).toBeUndefined();
      expect(failure!.text).toContain("<oops>");
    });

    it("agent replies remain plain by default when agentReplyParseMode is omitted", async () => {
      const { runtime } = makeFakeRuntime({
        scripts: [
          {
            events: [
              {
                type: "llm_event",
                event: {
                  type: "assistant_reply",
                  text: "**bold** stays literal",
                },
              },
            ],
          },
        ],
      });
      const api = makeFakeApi();
      const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
      await handleInboundText(makeUpdate("hi"), ctx);
      const reply = api.sent.find((m) => m.text.includes("**bold**"));
      expect(reply).toBeDefined();
      expect(reply!.text).toBe("**bold** stays literal");
      expect(reply!.opts).toBeUndefined();
    });
  });

  it("pairing is consulted before the owner check so a stale owner does not block pairing", async () => {
    const callOrder: string[] = [];
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const tryClaimForPairing = vi.fn(() => {
      callOrder.push("pairing");
      return true;
    });
    const ctx = {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      tryClaimForPairing,
    };
    await handleInboundText(makeUpdate("hi", NON_OWNER), ctx);
    expect(callOrder).toEqual(["pairing"]);
  });
});

// ---------------------------------------------------------------------------
// Per-chat sessions: groups, forum topics, /sessions, /switch, v1 migration.
// ---------------------------------------------------------------------------

const REPLY_SCRIPT = {
  events: [
    {
      type: "llm_event" as const,
      event: { type: "assistant_reply" as const, text: "ok" },
    },
  ],
};

function groupUpdate(
  text: string,
  over: Partial<InboundTextUpdate> = {},
): InboundTextUpdate {
  return {
    from: { id: OWNER },
    chat: { id: GROUP, type: "supergroup", title: "Ops" },
    text,
    message_id: 1,
    ...over,
  };
}

describe("handleInboundText — per-chat sessions", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-perchat-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxWithBot(
    runtime: AgentRuntime,
    api: TelegramApi,
    extra: Partial<InboundContext> = {},
  ): InboundContext {
    return {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      botIdentity: BOT,
      ...extra,
    };
  }

  it("ignores a group message that does not address the bot", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("just chatting"),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("acts on an @mention in a group and strips the addressing", async () => {
    const { runtime, calls } = makeFakeRuntime({ scripts: [REPLY_SCRIPT] });
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("@Atomic_Bot, deploy staging"),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe("deploy staging");
    // The group gets its own session, keyed by chat id.
    expect(pointer.get(String(GROUP)).current).toBe(calls[0]!.sessionId);
    expect(pointer.get(String(GROUP)).label).toBe("Ops");
    expect(api.sent.at(-1)!.chatId).toBe(GROUP);
  });

  it("does not match a longer username that merely starts with ours", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("@atomic_bot_v2 deploy"),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(0);
  });

  it("acts on a reply to one of the bot's own messages", async () => {
    const { runtime, calls } = makeFakeRuntime({ scripts: [REPLY_SCRIPT] });
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("yes do it", {
        reply_to_message: { from: { id: BOT.id, is_bot: true } },
      }),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toBe("yes do it");
  });

  it("ignores a reply to somebody else", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("yes do it", { reply_to_message: { from: { id: 555 } } }),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(0);
  });

  it("drops a non-owner in a group even when they mention the bot", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("@atomic_bot hi", { from: { id: NON_OWNER } }),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("never lets a group message claim pairing", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const tryClaimForPairing = vi.fn().mockReturnValue(true);
    await handleInboundText(
      groupUpdate("@atomic_bot hi", { from: { id: NON_OWNER } }),
      ctxWithBot(runtime, api, { tryClaimForPairing }),
    );
    expect(tryClaimForPairing).not.toHaveBeenCalled();
  });

  it("handles a slash command addressed as /cmd@bot in a group", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("/status@atomic_bot"),
      ctxWithBot(runtime, api),
    );
    expect(calls).toHaveLength(0);
    expect(api.sent[0]!.text).toContain("No active session for this chat");
    // A bare /status in a group is for whichever bot it was meant for.
    await handleInboundText(groupUpdate("/status"), ctxWithBot(runtime, api));
    expect(api.sent).toHaveLength(1);
  });

  it("gives the DM and a group different sessions and different reply targets", async () => {
    const { runtime, calls, sessions } = makeFakeRuntime({
      scripts: [REPLY_SCRIPT, REPLY_SCRIPT, REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(makeUpdate("project A"), ctx);
    await handleInboundText(groupUpdate("@atomic_bot project B"), ctx);
    await handleInboundText(makeUpdate("more A"), ctx);
    expect(sessions).toHaveLength(2);
    expect(calls.map((c) => c.sessionId)).toEqual([
      sessions[0]!.id,
      sessions[1]!.id,
      sessions[0]!.id,
    ]);
    // Replies (not the transient progress bubbles) go back where asked.
    expect(
      api.sent.filter((m) => m.text === "ok").map((m) => m.chatId),
    ).toEqual([CHAT, GROUP, CHAT]);
  });

  it("keys a forum topic separately and routes every send into the topic", async () => {
    const { runtime, calls, sessions } = makeFakeRuntime({
      scripts: [REPLY_SCRIPT, REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const ensureApprovalSession = vi.fn();
    const ctx = ctxWithBot(runtime, api, { ensureApprovalSession });
    const inTopic = groupUpdate("@atomic_bot topic work", {
      message_thread_id: 77,
      is_topic_message: true,
    });
    await handleInboundText(inTopic, ctx);
    await handleInboundText(groupUpdate("@atomic_bot general work"), ctx);
    expect(sessions).toHaveLength(2);
    expect(pointer.get(`${GROUP}:77`).current).toBe(calls[0]!.sessionId);
    expect(pointer.get(`${GROUP}:77`).label).toBe("Ops › topic 77");
    expect(pointer.get(String(GROUP)).current).toBe(calls[1]!.sessionId);
    // Progress bubble + reply for the topic carry message_thread_id;
    // the General-topic turn carries none.
    const topicSends = api.sent.filter((m) => m.opts?.message_thread_id === 77);
    expect(topicSends.length).toBeGreaterThanOrEqual(2);
    expect(topicSends.map((m) => m.text)).toContain("ok");
    expect(
      api.sent.some(
        (m) => m.text === "ok" && m.opts?.message_thread_id === undefined,
      ),
    ).toBe(true);
    expect(ensureApprovalSession).toHaveBeenNthCalledWith(
      1,
      calls[0]!.sessionId,
      {
        chatId: GROUP,
        threadId: 77,
      },
    );
    // The typing action follows the topic too; the General turn sends none.
    expect(api.typing[0]).toEqual({
      chatId: GROUP,
      opts: { message_thread_id: 77 },
    });
    expect(api.typing.at(-1)).toEqual({ chatId: GROUP, opts: undefined });
    expect(ensureApprovalSession).toHaveBeenNthCalledWith(
      2,
      calls[1]!.sessionId,
      {
        chatId: GROUP,
      },
    );
    expect(sessions[0]!.metadata).toMatchObject({
      telegramChat: { id: GROUP, type: "supergroup", threadId: 77 },
    });
  });

  it("a plain reply in a non-forum group is not treated as a topic", async () => {
    const { runtime, calls } = makeFakeRuntime({ scripts: [REPLY_SCRIPT] });
    const api = makeFakeApi();
    await handleInboundText(
      groupUpdate("@atomic_bot hi", { message_thread_id: 12 }),
      ctxWithBot(runtime, api),
    );
    expect(pointer.get(String(GROUP)).current).toBe(calls[0]!.sessionId);
    expect(api.sent.every((m) => m.opts?.message_thread_id === undefined)).toBe(
      true,
    );
  });

  it("/cancel only aborts this chat's turn", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    const dm = new AbortController();
    const group = new AbortController();
    ctx.inflight.set(CHAT_KEY, dm);
    ctx.inflight.set(String(GROUP), group);
    await handleInboundText(groupUpdate("/cancel@atomic_bot"), ctx);
    expect(group.signal.aborted).toBe(true);
    expect(dm.signal.aborted).toBe(false);
  });

  it("adopts the pre-per-chat pointer for the owner's DM but not for a group", async () => {
    const seeded = createEmptySessionState({
      id: "s-legacy",
      workingDir: "/tmp/test",
    });
    writeFileSync(
      join(dir, "telegram-session.json"),
      JSON.stringify({ current: "s-legacy", history: ["s-1"] }),
    );
    const { runtime, calls } = makeFakeRuntime({
      initialSessions: [seeded],
      scripts: [REPLY_SCRIPT, REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(groupUpdate("@atomic_bot hi"), ctx);
    expect(calls[0]!.sessionId).not.toBe("s-legacy");
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(calls[1]!.sessionId).toBe("s-legacy");
    expect(pointer.get(CHAT_KEY)).toMatchObject({
      current: "s-legacy",
      history: ["s-1"],
    });
    expect(pointer.hasLegacy()).toBe(false);
  });

  it("/sessions lists every chat and marks this one", async () => {
    pointer.setCurrent(CHAT_KEY, "s-dm", "DM");
    pointer.setCurrent(String(GROUP), "s-ops", "Ops");
    pointer.rotate(String(GROUP));
    pointer.setCurrent(String(GROUP), "s-ops-2", "Ops");
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(makeUpdate("/sessions"), ctxWithBot(runtime, api));
    const text = api.sent[0]!.text;
    expect(text).toContain("• DM (this chat): s-dm");
    expect(text).toContain("• Ops: s-ops-2, 1 archived");
    expect(text).toContain("/switch");
  });

  it("/sessions with nothing recorded says so", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(makeUpdate("/sessions"), ctxWithBot(runtime, api));
    expect(api.sent[0]!.text).toContain("No sessions yet");
  });

  it("/switch continues an archived session in this chat", async () => {
    const archived = createEmptySessionState({
      id: "s-archived",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    pointer.setCurrent(CHAT_KEY, "s-archived");
    pointer.rotate(CHAT_KEY);
    pointer.setCurrent(CHAT_KEY, "s-now");
    const { runtime, calls } = makeFakeRuntime({
      initialSessions: [archived],
      scripts: [REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const releaseApprovalSession = vi.fn();
    const ctx = ctxWithBot(runtime, api, { releaseApprovalSession });
    await handleInboundText(makeUpdate("/switch s-archived"), ctx);
    expect(api.sent[0]!.text).toContain("now continues session s-archived");
    expect(pointer.get(CHAT_KEY)).toMatchObject({
      current: "s-archived",
      history: ["s-now"],
    });
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-now");
    await handleInboundText(makeUpdate("go on"), ctx);
    expect(calls[0]!.sessionId).toBe("s-archived");
  });

  it("/switch rejects unknown ids, missing ids and sessions held by another chat", async () => {
    const held = createEmptySessionState({
      id: "s-held",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    pointer.setCurrent(String(GROUP), "s-held", "Ops");
    const { runtime } = makeFakeRuntime({ initialSessions: [held] });
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(makeUpdate("/switch"), ctx);
    expect(api.sent[0]!.text).toContain("Usage: /switch");
    await handleInboundText(makeUpdate("/switch s-nope"), ctx);
    expect(api.sent[1]!.text).toBe("Unknown session s-nope.");
    await handleInboundText(makeUpdate("/switch s-held"), ctx);
    expect(api.sent[2]!.text).toContain("active in another chat (Ops)");
    expect(pointer.get(CHAT_KEY).current).toBeNull();
  });
});

describe("handleInboundText — review follow-ups", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-followups-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxWithBot(
    runtime: AgentRuntime,
    api: TelegramApi,
    extra: Partial<InboundContext> = {},
  ): InboundContext {
    return {
      ...makeContext(runtime, api, pointer, OWNER, join(dir, "inbox")),
      botIdentity: BOT,
      ...extra,
    };
  }

  it("resolves the v1 pointer before a DM slash command, so /new really archives it", async () => {
    const legacy = createEmptySessionState({
      id: "s-legacy",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    writeFileSync(
      join(dir, "telegram-session.json"),
      JSON.stringify({ current: "s-legacy", history: ["s-1"] }),
    );
    const { runtime, calls } = makeFakeRuntime({
      initialSessions: [legacy],
      scripts: [REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const releaseApprovalSession = vi.fn();
    const ctx = ctxWithBot(runtime, api, { releaseApprovalSession });
    await handleInboundText(makeUpdate("/status"), ctx);
    expect(api.sent[0]!.text).toContain("Session: s-legacy");
    await handleInboundText(makeUpdate("/new"), ctx);
    expect(api.sent[1]!.text).toContain("Previous session s-legacy archived");
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-legacy");
    expect(pointer.get(CHAT_KEY)).toMatchObject({
      current: null,
      history: ["s-legacy", "s-1"],
    });
    expect(pointer.hasLegacy()).toBe(false);
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(calls[0]!.sessionId).not.toBe("s-legacy");
  });

  it("/switch first after the upgrade still keeps the legacy session reachable", async () => {
    const legacy = createEmptySessionState({
      id: "s-legacy",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    const other = createEmptySessionState({
      id: "s-x",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    writeFileSync(
      join(dir, "telegram-session.json"),
      JSON.stringify({ current: "s-legacy" }),
    );
    const { runtime } = makeFakeRuntime({ initialSessions: [legacy, other] });
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(makeUpdate("/switch s-x"), ctx);
    expect(pointer.hasLegacy()).toBe(false);
    expect(pointer.get(CHAT_KEY)).toMatchObject({
      current: "s-x",
      history: ["s-legacy"],
    });
    await handleInboundText(makeUpdate("/sessions"), ctx);
    expect(api.sent[1]!.text).toContain("DM (this chat): s-x, 1 archived");
  });

  it("/switch refuses a session that belongs to the TUI or another channel, or is mid-turn", async () => {
    const tui = createEmptySessionState({
      id: "s-tui",
      workingDir: "/tmp/test",
    });
    const discord = createEmptySessionState({
      id: "s-discord",
      workingDir: "/tmp/test",
      metadata: { discordChannel: true },
    });
    const busy = createEmptySessionState({
      id: "s-busy",
      workingDir: "/tmp/test",
      metadata: { telegramChannel: true },
    });
    const { runtime } = makeFakeRuntime({
      initialSessions: [tui, discord, busy],
    });
    (runtime.turnController as { isBusy: (id: string) => boolean }).isBusy = (
      id,
    ) => id === "s-busy";
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(makeUpdate("/switch s-tui"), ctx);
    expect(api.sent[0]!.text).toContain("belongs to another surface");
    await handleInboundText(makeUpdate("/switch s-discord"), ctx);
    expect(api.sent[1]!.text).toContain("belongs to another surface");
    await handleInboundText(makeUpdate("/switch s-busy"), ctx);
    expect(api.sent[2]!.text).toContain("turn in progress");
    expect(pointer.get(CHAT_KEY).current).toBeNull();
  });

  it("/new during a running turn keeps the approval binding until the turn settles", async () => {
    let finish: (() => void) | null = null;
    const runtime = {
      ...makeFakeRuntime().runtime,
      runTurn: async (
        _s: unknown,
        _t: string,
        opts: { eventHook?: (e: AgentLoopEvent) => void },
      ) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        opts.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "ok" },
        } as AgentLoopEvent);
        return {};
      },
    } as unknown as AgentRuntime;
    const api = makeFakeApi();
    const releaseApprovalSession = vi.fn();
    const ctx = ctxWithBot(runtime, api, { releaseApprovalSession });
    const turn = handleInboundText(makeUpdate("long task"), ctx);
    // Let dispatch reach runTurn.
    await new Promise((r) => setTimeout(r, 0));
    const sessionId = pointer.get(CHAT_KEY).current!;
    expect(ctx.inflight.has(CHAT_KEY)).toBe(true);
    await handleInboundText(makeUpdate("/new"), ctx);
    // Rotated, but the keyboard for the running turn is still wired.
    expect(pointer.get(CHAT_KEY).current).toBeNull();
    expect(releaseApprovalSession).not.toHaveBeenCalled();
    finish!();
    await turn;
    expect(releaseApprovalSession).toHaveBeenCalledWith(sessionId);
    expect(ctx.inflight.has(CHAT_KEY)).toBe(false);
  });

  it("recreating over a pointer to a pruned session releases the stale binding", async () => {
    pointer.setCurrent(CHAT_KEY, "s-gone");
    const { runtime, calls } = makeFakeRuntime({ scripts: [REPLY_SCRIPT] });
    const api = makeFakeApi();
    const releaseApprovalSession = vi.fn();
    await handleInboundText(
      makeUpdate("hi"),
      ctxWithBot(runtime, api, { releaseApprovalSession }),
    );
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-gone");
    expect(calls[0]!.sessionId).not.toBe("s-gone");
  });

  it("does not warn about unaddressed group chatter from non-owners", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const warn = vi.fn();
    const ctx = ctxWithBot(runtime, api);
    ctx.logger.warn = warn as unknown as typeof ctx.logger.warn;
    await handleInboundText(
      groupUpdate("random chatter", { from: { id: NON_OWNER } }),
      ctx,
    );
    expect(warn).not.toHaveBeenCalled();
    // …but a non-owner who actually addresses the bot is worth a line.
    await handleInboundText(
      groupUpdate("@atomic_bot hi", { from: { id: NON_OWNER } }),
      ctx,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("matches mentions on Telegram's word boundaries, not whitespace", async () => {
    const { runtime, calls } = makeFakeRuntime({
      scripts: [REPLY_SCRIPT, REPLY_SCRIPT],
    });
    const api = makeFakeApi();
    const ctx = ctxWithBot(runtime, api);
    await handleInboundText(groupUpdate("(@atomic_bot) run tests"), ctx);
    expect(calls[0]!.userMessage).toBe("run tests");
    await handleInboundText(groupUpdate("hi,@atomic_bot status?"), ctx);
    expect(calls[1]!.userMessage).toBe("hi,@atomic_bot status?");
    await handleInboundText(
      groupUpdate("mail me at x@atomic_bot.example"),
      ctx,
    );
    await handleInboundText(groupUpdate("привет@atomic_bot"), ctx);
    expect(calls).toHaveLength(2);
  });

  it("help text says how to reach the bot in a group depending on privacy mode", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    await handleInboundText(
      makeUpdate("/help"),
      ctxWithBot(runtime, api, {
        botIdentity: { ...BOT, canReadAllGroupMessages: false },
      }),
    );
    expect(api.sent[0]!.text).toContain("privacy mode is on");
    expect(api.sent[0]!.text).toContain("/cmd@atomic_bot");
    await handleInboundText(
      makeUpdate("/help"),
      ctxWithBot(runtime, api, {
        botIdentity: { ...BOT, canReadAllGroupMessages: true },
      }),
    );
    expect(api.sent[1]!.text).toContain("@mention me");
    expect(api.sent[1]!.text).not.toContain("privacy mode");
  });
});

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeFileUpdate(
  over: Partial<InboundFileUpdate> = {},
  file: Partial<InboundFileUpdate["file"]> = {},
): InboundFileUpdate {
  return {
    from: { id: OWNER },
    chat: { id: CHAT, type: "private" },
    message_id: 7,
    file: { kind: "photo", file_id: "photo-1", file_size: 6, ...file },
    ...over,
  };
}

function withDownload(
  api: FakeApi,
  impl: (fileId: string) => Promise<Uint8Array> = async () => JPEG_BYTES,
): FakeApi & { downloadFile: ReturnType<typeof vi.fn> } {
  const downloadFile = vi.fn(impl);
  return Object.assign(api, { downloadFile });
}

const replyScript = {
  scripts: [
    {
      events: [
        {
          type: "llm_event" as const,
          event: { type: "assistant_reply" as const, text: "got it" },
        },
      ],
    },
  ],
};

describe("handleInboundFile", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-file-handler-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads the owner's photo into the inbox and dispatches caption + path", async () => {
    const { runtime, calls } = makeFakeRuntime(replyScript);
    const api = withDownload(makeFakeApi());
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate({ caption: "what is this?" }), ctx);

    expect(api.downloadFile).toHaveBeenCalledWith("photo-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.origin).toBe("telegram");
    const message = calls[0]!.userMessage;
    expect(message.startsWith("what is this?\n\n[attachments]\n- ")).toBe(true);
    const path = /^- (\S+) \(image\/jpeg, 6 B\)$/m.exec(message)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(join(dir, "inbox"))).toBe(true);
    expect(path!.endsWith("-photo.jpg")).toBe(true);
    expect(readFileSync(path!)).toEqual(Buffer.from(JPEG_BYTES));
    expect(message).toContain("vision.describe");
    expect(api.sent.some((m) => m.text === "got it")).toBe(true);
  });

  it("keeps a document's own name and MIME type", async () => {
    const { runtime, calls } = makeFakeRuntime(replyScript);
    const api = withDownload(makeFakeApi(), async () => new Uint8Array([1, 2]));
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(
      makeFileUpdate(
        {},
        {
          kind: "document",
          file_id: "doc-1",
          file_name: "Q3 report.pdf",
          mime_type: "application/pdf",
          file_size: 2,
        },
      ),
      ctx,
    );

    expect(calls[0]!.userMessage).toMatch(
      /-Q3_report\.pdf \(application\/pdf, 2 B\)/,
    );
    expect(calls[0]!.userMessage).toMatch(
      /^The user sent a file without a message\./,
    );
  });

  it("drops files from non-owners without touching Telegram", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = withDownload(makeFakeApi());
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate({ from: { id: NON_OWNER } }), ctx);
    await handleInboundFile(
      makeFileUpdate({ chat: { id: CHAT, type: "group" } }),
      ctx,
    );

    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("refuses a file over the 20 MB bot limit before calling Telegram", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = withDownload(makeFakeApi());
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(
      makeFileUpdate(
        {},
        {
          kind: "document",
          file_id: "big",
          file_name: "big.zip",
          file_size: TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES + 1,
        },
      ),
      ctx,
    );

    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text).toBe(
      "Could not receive big.zip: Telegram bots cannot download files over 20.0 MB",
    );
    expect(api.sent[0]!.opts).toBeUndefined();
  });

  it("reports a failed download to the operator and still dispatches the caption", async () => {
    const { runtime, calls } = makeFakeRuntime(replyScript);
    const api = withDownload(makeFakeApi(), async () => {
      throw new Error("Bad Request: file is too big");
    });
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate({ caption: "summarise this" }), ctx);

    expect(api.sent[0]!.text).toBe(
      "Could not receive photo: Bad Request: file is too big",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toContain("summarise this");
    expect(calls[0]!.userMessage).toContain(
      "- photo: not saved (Bad Request: file is too big)",
    );
    expect(calls[0]!.userMessage).not.toContain("vision.describe");
  });

  it("a failed download with no caption never reaches the agent", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = withDownload(makeFakeApi(), async () => {
      throw new Error("boom");
    });
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate(), ctx);

    expect(calls).toHaveLength(0);
    expect(api.sent.map((m) => m.text)).toEqual([
      "Could not receive photo: boom",
    ]);
  });

  it("scrubs a bot token out of download errors", async () => {
    const { runtime } = makeFakeRuntime();
    const token = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr";
    const api = withDownload(makeFakeApi(), async () => {
      throw new Error(
        `fetch failed for https://api.telegram.org/file/bot${token}/x`,
      );
    });
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate(), ctx);

    expect(api.sent[0]!.text).toContain("<token>");
    expect(api.sent[0]!.text).not.toContain(token);
  });

  it("reports an adapter without downloadFile as unsupported instead of dropping", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));

    await handleInboundFile(makeFileUpdate(), ctx);

    expect(calls).toHaveLength(0);
    expect(api.sent[0]!.text).toMatch(/not supported/);
  });

  it("coalesces an album into a single turn listing every member", async () => {
    const { runtime, calls } = makeFakeRuntime(replyScript);
    const api = withDownload(makeFakeApi(), async (id) =>
      id === "p1" ? JPEG_BYTES : new Uint8Array([9, 9]),
    );
    const flushes: Array<() => void> = [];
    let cancelled = 0;
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    ctx.scheduleMediaGroupFlush = (cb) => {
      flushes.push(cb);
      return () => {
        cancelled += 1;
      };
    };

    await handleInboundFile(
      makeFileUpdate(
        { media_group_id: "album-1" },
        { file_id: "p1", file_size: 6 },
      ),
      ctx,
    );
    await handleInboundFile(
      makeFileUpdate(
        { media_group_id: "album-1", caption: "two shots" },
        { file_id: "p2", file_size: 2 },
      ),
      ctx,
    );

    // Nothing dispatched while the window is open; the second member
    // restarted the timer.
    expect(calls).toHaveLength(0);
    expect(flushes).toHaveLength(2);
    expect(cancelled).toBe(1);
    expect(ctx.mediaGroups.size).toBe(1);

    flushes[1]!();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const message = calls[0]!.userMessage;
    expect(message.startsWith("two shots\n\n[attachments]\n")).toBe(true);
    expect(
      message.match(/^- .*-photo(-2)?\.jpg \(image\/jpeg, /gm),
    ).toHaveLength(2);
    expect(ctx.mediaGroups.size).toBe(0);
  });

  it("lets a file DM claim an open pairing window before the owner check", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = withDownload(makeFakeApi());
    const ctx = makeContext(runtime, api, pointer, null, join(dir, "inbox"));
    const claims: InboundTextUpdate[] = [];
    ctx.tryClaimForPairing = (u) => {
      claims.push(u);
      return true;
    };

    await handleInboundFile(makeFileUpdate({ from: { id: 777 } }), ctx);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ from: { id: 777 }, text: "[photo]" });
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
