import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  return {
    sent,
    typingChats,
    edits,
    deletes,
    sendMessage: vi.fn(
      async (
        chatId: number,
        text: string,
        opts?: Record<string, unknown>,
      ) => {
        sent.push({ chatId, text, opts });
        return { message_id: sent.length };
      },
    ),
    sendChatAction: vi.fn(async (chatId: number) => {
      typingChats.push(chatId);
      return undefined;
    }),
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
): InboundContext & { inflight: Map<number, AbortController> } {
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
const NON_OWNER = 99;

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

  it("drops group-chat messages silently", async () => {
    const { runtime, calls } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("hello", OWNER, "group"), ctx);
    expect(calls).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
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

  it("/new rotates the pointer and acks", async () => {
    pointer.setCurrent("s-old");
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/new"), ctx);
    expect(pointer.read().current).toBeNull();
    expect(pointer.read().history).toEqual(["s-old"]);
    expect(api.sent[0]!.text).toContain("s-old");
  });

  it("/cancel reports no in-flight when nothing is running", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    await handleInboundText(makeUpdate("/cancel"), ctx);
    expect(api.sent[0]!.text).toBe("No turn in progress.");
  });

  it("/cancel aborts the in-flight controller", async () => {
    const { runtime } = makeFakeRuntime();
    const api = makeFakeApi();
    const ctx = makeContext(runtime, api, pointer, OWNER, join(dir, "inbox"));
    const ctrl = new AbortController();
    ctx.inflight.set(CHAT, ctrl);
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
    expect(pointer.read().current).toBeNull();
    await handleInboundText(makeUpdate("hello"), ctx);
    expect(sessions.length).toBe(1);
    expect(pointer.read().current).toBe(sessions[0]!.id);
  });

  it("reuses the existing session on subsequent messages", async () => {
    const seeded = createEmptySessionState({
      id: "s-existing",
      workingDir: "/tmp/test",
    });
    pointer.setCurrent(seeded.id);
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
    expect(ensureApprovalSession).toHaveBeenCalledWith(sessions[0]!.id, CHAT);
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
      const reply = api.sent.find((m) =>
        m.text.includes("<b>bold</b>"),
      );
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

    expect(calls[0]!.userMessage).toMatch(/-Q3_report\.pdf \(application\/pdf, 2 B\)/);
    expect(calls[0]!.userMessage).toMatch(/^The user sent a file without a message\./);
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
    expect(api.sent.map((m) => m.text)).toEqual(["Could not receive photo: boom"]);
  });

  it("scrubs a bot token out of download errors", async () => {
    const { runtime } = makeFakeRuntime();
    const token = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr";
    const api = withDownload(makeFakeApi(), async () => {
      throw new Error(`fetch failed for https://api.telegram.org/file/bot${token}/x`);
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
      makeFileUpdate({ media_group_id: "album-1" }, { file_id: "p1", file_size: 6 }),
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
    expect(message.match(/^- .*-photo(-2)?\.jpg \(image\/jpeg, /gm)).toHaveLength(2);
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
