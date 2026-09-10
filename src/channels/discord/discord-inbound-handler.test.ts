import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAttachmentInbox } from "../attachments/inbox.js";
import {
  DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES,
  handleDiscordMessage,
  stripMention,
  type DiscordAttachment,
  type DiscordInboundContext,
  type DiscordMessageEvent,
} from "./discord-inbound-handler.js";

let inboxDir: string;

beforeEach(() => {
  inboxDir = mkdtempSync(join(tmpdir(), "atomic-discord-inbox-"));
});

afterEach(() => {
  rmSync(inboxDir, { recursive: true, force: true });
});

const BOT = "999";
const OWNER = "111";

/** In-memory stand-in for `DiscordSessionPointer` with the same surface. */
function fakePointer(
  seed: Record<
    string,
    { current: string | null; history?: string[]; label?: string }
  > = {},
  legacy: { current: string | null; history?: string[] } | null = null,
) {
  const chats = new Map(Object.entries(seed));
  let pending = legacy;
  return {
    chats,
    get: (key: string) => chats.get(key) ?? { current: null },
    entries: () =>
      [...chats.entries()].map(([chatKey, entry]) => ({ chatKey, entry })),
    hasLegacy: () => pending !== null,
    setCurrent: vi.fn((key: string, id: string, label?: string) => {
      const prev = chats.get(key);
      const history =
        prev?.current && prev.current !== id
          ? [prev.current, ...(prev.history ?? [])]
          : prev?.history;
      chats.set(key, {
        current: id,
        ...(history && history.length > 0 ? { history } : {}),
        ...((label ?? prev?.label) ? { label: label ?? prev?.label } : {}),
      });
    }),
    rotate: vi.fn((key: string) => {
      const prev = chats.get(key);
      if (!prev?.current) return;
      chats.set(key, {
        ...prev,
        current: null,
        history: [prev.current, ...(prev.history ?? [])],
      });
    }),
    adoptLegacy: vi.fn((key: string, label?: string) => {
      if (!pending || chats.has(key)) return null;
      const { current } = pending;
      chats.set(key, { ...pending, ...(label ? { label } : {}) });
      pending = null;
      return current;
    }),
  };
}

function makeCtx(
  overrides: Partial<DiscordInboundContext> = {},
): DiscordInboundContext & {
  sent: string[];
  sentTo: string[];
  runTurn: ReturnType<typeof vi.fn>;
} {
  const sent: string[] = [];
  const sentTo: string[] = [];
  const runTurn = vi.fn(
    async (
      _s: unknown,
      _t: string,
      opts: {
        eventHook?: (e: unknown) => void;
      },
    ) => {
      opts.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "done" },
      });
      return {};
    },
  );
  const ctx = {
    runtime: {
      runTurn,
      createSession: () => ({ id: "s1" }),
      sessionStore: { load: () => null },
      turnController: { isBusy: () => false },
    },
    api: {
      sendMessage: vi.fn(async (channelId: string, text: string) => {
        sent.push(text);
        sentTo.push(channelId);
        return "m1";
      }),
    },
    sessionPointer: fakePointer(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ownerUserId: OWNER,
    botUserId: BOT,
    inflight: new Map(),
    inbox: createAttachmentInbox({ dir: inboxDir }),
    ...overrides,
  } as unknown as DiscordInboundContext;
  return Object.assign(ctx, { sent, sentTo, runTurn });
}

function msg(over: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
  return {
    id: "m",
    channel_id: "c1",
    content: "hello",
    author: { id: OWNER },
    ...over,
  };
}

describe("stripMention", () => {
  it("removes a leading mention in both forms", () => {
    expect(stripMention(`<@${BOT}> do it`, BOT)).toBe(" do it");
    expect(stripMention(`<@!${BOT}> do it`, BOT)).toBe(" do it");
  });

  it("leaves a mention inside the sentence alone", () => {
    // "ask <@123> about it" is content, not addressing.
    expect(stripMention(`tell <@${BOT}> hi`, BOT)).toBe(`tell <@${BOT}> hi`);
  });
});

describe("handleDiscordMessage", () => {
  it("runs an owner DM through the agent and posts the reply", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg(), ctx);
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    expect(ctx.sent).toEqual(["done"]);
  });

  it("ignores its own messages", async () => {
    // Two agents in one guild would otherwise talk to each other forever.
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ author: { id: BOT } }), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
  });

  it("ignores other bots", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ author: { id: "222", bot: true } }), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
  });

  it("drops a message from anyone but the paired owner", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ author: { id: "impostor" } }), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual([]);
  });

  it("refuses everything while unpaired", async () => {
    // A token with no owner must not accept commands from the internet.
    const ctx = makeCtx({ ownerUserId: null });
    await handleDiscordMessage(msg(), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
  });

  it("ignores a guild message that does not mention the bot", async () => {
    // Without this the agent would act on every message in any channel
    // it can see.
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ guild_id: "g1" }), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
  });

  it("acts on a guild message that mentions the bot", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(
      msg({
        guild_id: "g1",
        content: `<@${BOT}> ship it`,
        mentions: [{ id: BOT }],
      }),
      ctx,
    );
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    expect(ctx.runTurn.mock.calls[0]?.[1]).toBe("ship it");
  });

  it("lets pairing claim a message before the owner check", async () => {
    const tryClaimForPairing = vi.fn(() => true);
    const ctx = makeCtx({ ownerUserId: null, tryClaimForPairing });
    await handleDiscordMessage(msg({ author: { id: "new-owner" } }), ctx);
    expect(tryClaimForPairing).toHaveBeenCalled();
    expect(ctx.runTurn).not.toHaveBeenCalled();
  });

  it("answers /help without touching the agent", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ content: "/help" }), ctx);
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent[0]).toContain("Discord remote control");
  });

  it("cancels an in-flight turn on /cancel", async () => {
    const controller = new AbortController();
    const ctx = makeCtx({ inflight: new Map([["c1", controller]]) });
    await handleDiscordMessage(msg({ content: "/cancel" }), ctx);
    expect(controller.signal.aborted).toBe(true);
  });

  it("says so when /cancel has nothing to cancel", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg({ content: "/cancel" }), ctx);
    expect(ctx.sent[0]).toBe("No turn in progress in this channel.");
  });

  it("binds approvals before the turn can request one", async () => {
    // Otherwise a destructive tool prompts on the operator's TUI, which
    // the person driving from Discord cannot see.
    const ensureApprovalSession = vi.fn();
    const ctx = makeCtx({ ensureApprovalSession });
    await handleDiscordMessage(msg(), ctx);
    expect(ensureApprovalSession).toHaveBeenCalledWith("s1", "c1");
    expect(ensureApprovalSession.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runTurn.mock.invocationCallOrder[0]!,
    );
  });

  it("reports a failed turn instead of going silent", async () => {
    const ctx = makeCtx();
    (
      ctx.runtime.runTurn as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    await handleDiscordMessage(msg(), ctx);
    expect(ctx.sent[0]).toContain("Turn failed");
    expect(ctx.sent[0]).toContain("boom");
  });

  it("never throws past the boundary on a malformed event", async () => {
    // One bad frame must not take the gateway down.
    const ctx = makeCtx();
    await expect(
      handleDiscordMessage({} as DiscordMessageEvent, ctx),
    ).resolves.toBeUndefined();
  });

  it("clears the inflight entry when the turn settles", async () => {
    const ctx = makeCtx();
    await handleDiscordMessage(msg(), ctx);
    expect(ctx.inflight.size).toBe(0);
  });
});

describe("handleDiscordMessage — per-channel sessions", () => {
  /** A runtime whose sessions are real enough to be looked up again. */
  function sessionfulRuntime(
    known: string[] = [],
    opts: { busy?: string[]; foreign?: string[] } = {},
  ) {
    let n = 0;
    const store = new Set(known);
    const foreign = new Set(opts.foreign ?? []);
    const busy = new Set(opts.busy ?? []);
    const created: Array<{ id: string; metadata?: Record<string, unknown> }> =
      [];
    return {
      created,
      runtime: {
        runTurn: vi.fn(
          async (
            _s: unknown,
            _t: string,
            opts: { eventHook?: (e: unknown) => void },
          ) => {
            opts.eventHook?.({
              type: "llm_event",
              event: { type: "assistant_reply", text: "done" },
            });
            return {};
          },
        ),
        createSession: (input?: { metadata?: Record<string, unknown> }) => {
          const id = `s${++n}`;
          store.add(id);
          const session = {
            id,
            ...(input?.metadata ? { metadata: input.metadata } : {}),
          };
          created.push(session);
          return session;
        },
        sessionStore: {
          load: (id: string) =>
            store.has(id)
              ? {
                  id,
                  metadata: foreign.has(id)
                    ? { tui: true }
                    : { discordChannel: true },
                }
              : null,
        },
        turnController: { isBusy: (id: string) => busy.has(id) },
      },
    };
  }

  it("gives two guild channels and a DM three different sessions", async () => {
    const { runtime, created } = sessionfulRuntime();
    const pointer = fakePointer();
    const ctx = makeCtx({
      runtime: runtime as never,
      sessionPointer: pointer as never,
    });
    const mention = { content: `<@${BOT}> hi`, mentions: [{ id: BOT }] };
    await handleDiscordMessage(
      msg({ channel_id: "a", guild_id: "g1", ...mention }),
      ctx,
    );
    await handleDiscordMessage(
      msg({ channel_id: "b", guild_id: "g1", ...mention }),
      ctx,
    );
    await handleDiscordMessage(msg({ channel_id: "dm" }), ctx);
    await handleDiscordMessage(
      msg({ channel_id: "a", guild_id: "g1", ...mention }),
      ctx,
    );
    expect(created.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const sessionsUsed = (
      ctx.runtime.runTurn as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(sessionsUsed).toEqual(["s1", "s2", "s3", "s1"]);
    expect(pointer.get("a").current).toBe("s1");
    expect(pointer.get("b").current).toBe("s2");
    expect(pointer.get("dm")).toMatchObject({ current: "s3", label: "DM" });
    expect(ctx.sentTo).toEqual(["a", "b", "dm", "a"]);
    expect(created[0]!.metadata).toMatchObject({
      discordChannel: true,
      discordChat: { channelId: "a", guildId: "g1" },
    });
  });

  it("adopts the pre-per-channel pointer for a DM but not for a guild channel", async () => {
    const { runtime } = sessionfulRuntime(["s-legacy"]);
    const pointer = fakePointer({}, { current: "s-legacy" });
    const ctx = makeCtx({
      runtime: runtime as never,
      sessionPointer: pointer as never,
    });
    await handleDiscordMessage(
      msg({
        channel_id: "a",
        guild_id: "g1",
        content: `<@${BOT}> hi`,
        mentions: [{ id: BOT }],
      }),
      ctx,
    );
    expect(pointer.get("a").current).toBe("s1");
    expect(pointer.hasLegacy()).toBe(true);
    await handleDiscordMessage(msg({ channel_id: "dm" }), ctx);
    expect(pointer.get("dm").current).toBe("s-legacy");
    expect(pointer.hasLegacy()).toBe(false);
  });

  it("/new rotates only this channel and releases its approval binding", async () => {
    const pointer = fakePointer({
      c1: { current: "s-old" },
      c2: { current: "s-keep" },
    });
    const releaseApprovalSession = vi.fn();
    const ctx = makeCtx({
      sessionPointer: pointer as never,
      releaseApprovalSession,
    });
    await handleDiscordMessage(msg({ content: "/new" }), ctx);
    expect(pointer.get("c1")).toMatchObject({
      current: null,
      history: ["s-old"],
    });
    expect(pointer.get("c2").current).toBe("s-keep");
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-old");
    expect(ctx.sent[0]).toContain("s-old");
  });

  it("/status reports this channel's session", async () => {
    const pointer = fakePointer({
      c1: { current: "s-here" },
      c2: { current: "s-there" },
    });
    const ctx = makeCtx({ sessionPointer: pointer as never });
    await handleDiscordMessage(msg({ content: "/status" }), ctx);
    expect(ctx.sent[0]).toContain("s-here");
    expect(ctx.sent[0]).not.toContain("s-there");
  });

  it("/sessions lists every channel and marks this one", async () => {
    const pointer = fakePointer({
      c1: { current: "s-here", label: "channel c1" },
      dm: { current: "s-dm", label: "DM", history: ["s-dm-old"] },
    });
    const ctx = makeCtx({ sessionPointer: pointer as never });
    await handleDiscordMessage(msg({ content: "/sessions" }), ctx);
    expect(ctx.sent[0]).toContain("<#c1> (this channel): `s-here`");
    expect(ctx.sent[0]).toContain("DM: `s-dm`, 1 archived");
  });

  it("/switch continues an existing session here and refuses one held elsewhere", async () => {
    const { runtime } = sessionfulRuntime(["s-archived", "s-held"]);
    const pointer = fakePointer({
      c1: { current: "s-now" },
      c2: { current: "s-held", label: "channel c2" },
    });
    const releaseApprovalSession = vi.fn();
    const ctx = makeCtx({
      runtime: runtime as never,
      sessionPointer: pointer as never,
      releaseApprovalSession,
    });
    await handleDiscordMessage(msg({ content: "/switch" }), ctx);
    expect(ctx.sent[0]).toContain("Usage");
    await handleDiscordMessage(msg({ content: "/switch s-nope" }), ctx);
    expect(ctx.sent[1]).toContain("Unknown session");
    await handleDiscordMessage(msg({ content: "/switch s-held" }), ctx);
    expect(ctx.sent[2]).toContain("active in another channel (channel c2)");
    expect(pointer.get("c1").current).toBe("s-now");
    await handleDiscordMessage(msg({ content: "/switch s-archived" }), ctx);
    expect(ctx.sent[3]).toContain("now continues session `s-archived`");
    expect(pointer.get("c1")).toMatchObject({
      current: "s-archived",
      history: ["s-now"],
    });
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-now");
    await handleDiscordMessage(msg({ content: "carry on" }), ctx);
    const used = (ctx.runtime.runTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { id: string };
    expect(used.id).toBe("s-archived");
  });
});

describe("handleDiscordMessage — review follow-ups", () => {
  it("resolves the v1 pointer before a DM slash command, so /new really archives it", async () => {
    const { runtime } = sessionfulRuntimeFor(["s-legacy"]);
    const pointer = fakePointer({}, { current: "s-legacy" });
    const releaseApprovalSession = vi.fn();
    const ctx = makeCtx({
      runtime: runtime as never,
      sessionPointer: pointer as never,
      releaseApprovalSession,
    });
    await handleDiscordMessage(
      msg({ channel_id: "dm", content: "/status" }),
      ctx,
    );
    expect(ctx.sent[0]).toContain("s-legacy");
    await handleDiscordMessage(msg({ channel_id: "dm", content: "/new" }), ctx);
    expect(ctx.sent[1]).toContain("`s-legacy` archived");
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-legacy");
    expect(pointer.hasLegacy()).toBe(false);
    await handleDiscordMessage(msg({ channel_id: "dm", content: "go" }), ctx);
    const used = (ctx.runtime.runTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { id: string };
    expect(used.id).not.toBe("s-legacy");
  });

  it("/switch refuses sessions from another surface and sessions mid-turn", async () => {
    const { runtime } = sessionfulRuntimeFor(["s-tui", "s-busy"], {
      foreign: ["s-tui"],
      busy: ["s-busy"],
    });
    const pointer = fakePointer();
    const ctx = makeCtx({
      runtime: runtime as never,
      sessionPointer: pointer as never,
    });
    await handleDiscordMessage(msg({ content: "/switch s-tui" }), ctx);
    expect(ctx.sent[0]).toContain("belongs to another surface");
    await handleDiscordMessage(msg({ content: "/switch s-busy" }), ctx);
    expect(ctx.sent[1]).toContain("turn in progress");
    expect(pointer.get("c1").current).toBeNull();
  });

  it("/new during a running turn keeps the approval binding until the turn settles", async () => {
    let finish: (() => void) | null = null;
    const pointer = fakePointer();
    const releaseApprovalSession = vi.fn();
    const ctx = makeCtx({
      sessionPointer: pointer as never,
      releaseApprovalSession,
    });
    (ctx.runtime.runTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (
        _s: unknown,
        _t: string,
        opts: { eventHook?: (e: unknown) => void },
      ) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        opts.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "done" },
        });
        return {};
      },
    );
    const turn = handleDiscordMessage(msg({ content: "long task" }), ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.inflight.has("c1")).toBe(true);
    await handleDiscordMessage(msg({ content: "/new" }), ctx);
    expect(pointer.get("c1").current).toBeNull();
    expect(releaseApprovalSession).not.toHaveBeenCalled();
    finish!();
    await turn;
    expect(releaseApprovalSession).toHaveBeenCalledWith("s1");
  });

  it("recreating over a pointer to a pruned session releases the stale binding", async () => {
    const pointer = fakePointer({ c1: { current: "s-gone" } });
    const releaseApprovalSession = vi.fn();
    const ctx = makeCtx({
      sessionPointer: pointer as never,
      releaseApprovalSession,
    });
    await handleDiscordMessage(msg(), ctx);
    expect(releaseApprovalSession).toHaveBeenCalledWith("s-gone");
    expect(pointer.get("c1").current).toBe("s1");
  });
});

/** Same runtime the per-channel block builds, exposed for the follow-up block. */
function sessionfulRuntimeFor(
  known: string[],
  opts: { busy?: string[]; foreign?: string[] } = {},
) {
  let n = 0;
  const store = new Set(known);
  const foreign = new Set(opts.foreign ?? []);
  const busy = new Set(opts.busy ?? []);
  return {
    runtime: {
      runTurn: vi.fn(
        async (
          _s: unknown,
          _t: string,
          o: { eventHook?: (e: unknown) => void },
        ) => {
          o.eventHook?.({
            type: "llm_event",
            event: { type: "assistant_reply", text: "done" },
          });
          return {};
        },
      ),
      createSession: () => {
        const id = `s${++n}`;
        store.add(id);
        return { id };
      },
      sessionStore: {
        load: (id: string) =>
          store.has(id)
            ? {
                id,
                metadata: foreign.has(id)
                  ? { tui: true }
                  : { discordChannel: true },
              }
            : null,
      },
      turnController: { isBusy: (id: string) => busy.has(id) },
    },
  };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function attachment(over: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return {
    id: "a1",
    filename: "shot.png",
    size: PNG_BYTES.byteLength,
    url: "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1&is=2&hm=3",
    content_type: "image/png",
    ...over,
  };
}

describe("handleDiscordMessage with attachments", () => {
  it("saves an attachment-only DM into the inbox and tells the agent where it is", async () => {
    const downloadAttachment = vi.fn(async () => PNG_BYTES);
    const ctx = makeCtx({ downloadAttachment });
    await handleDiscordMessage(
      msg({ content: "", attachments: [attachment()] }),
      ctx,
    );

    expect(downloadAttachment).toHaveBeenCalledWith(attachment().url);
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message).toMatch(
      /^The user sent a file without a message\.\n\n\[attachments\]\n- /,
    );
    const path = /^- (\S+) \(image\/png, 4 B\)$/m.exec(message)?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(inboxDir)).toBe(true);
    expect(path!.endsWith("-shot.png")).toBe(true);
    expect(readFileSync(path!)).toEqual(Buffer.from(PNG_BYTES));
    expect(ctx.sent).toEqual(["done"]);
  });

  it("leads with the message text when there is one", async () => {
    const ctx = makeCtx({ downloadAttachment: async () => PNG_BYTES });
    await handleDiscordMessage(
      msg({
        content: "what is on this screenshot?",
        attachments: [attachment()],
      }),
      ctx,
    );
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(
      message.startsWith("what is on this screenshot?\n\n[attachments]\n"),
    ).toBe(true);
    expect(message).toContain("vision.describe");
  });

  it("handles a guild @mention carrying a file", async () => {
    const ctx = makeCtx({ downloadAttachment: async () => PNG_BYTES });
    await handleDiscordMessage(
      msg({
        guild_id: "g1",
        content: `<@${BOT}> review this`,
        mentions: [{ id: BOT }],
        attachments: [
          attachment({ filename: "notes.txt", content_type: "text/plain" }),
        ],
      }),
      ctx,
    );
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message.startsWith("review this\n\n")).toBe(true);
    expect(message).toMatch(/-notes\.txt \(text\/plain, 4 B\)/);
  });

  it("saves every file of a multi-attachment message into one turn", async () => {
    const ctx = makeCtx({ downloadAttachment: async () => PNG_BYTES });
    await handleDiscordMessage(
      msg({
        content: "",
        attachments: [
          attachment({ id: "1", filename: "a.png" }),
          attachment({ id: "2", filename: "b.png" }),
        ],
      }),
      ctx,
    );
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message).toMatch(/^The user sent 2 files without a message\./);
    expect(
      message.match(/^- .*-(a|b)\.png \(image\/png, 4 B\)$/gm),
    ).toHaveLength(2);
  });

  it("reports a failed download and still dispatches the text", async () => {
    const ctx = makeCtx({
      downloadAttachment: async () => {
        throw new Error("Discord CDN returned HTTP 404");
      },
    });
    await handleDiscordMessage(
      msg({ content: "summarise", attachments: [attachment()] }),
      ctx,
    );
    expect(ctx.sent[0]).toBe(
      "Could not receive shot.png: Discord CDN returned HTTP 404",
    );
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message).toContain("summarise");
    expect(message).toContain(
      "- shot.png: not saved (Discord CDN returned HTTP 404)",
    );
  });

  it("a failed download with no text ends at the notice", async () => {
    const ctx = makeCtx({
      downloadAttachment: async () => {
        throw new Error("boom");
      },
    });
    await handleDiscordMessage(
      msg({ content: "", attachments: [attachment()] }),
      ctx,
    );
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual(["Could not receive shot.png: boom"]);
  });

  it("refuses a file over the inbound limit without downloading it", async () => {
    const downloadAttachment = vi.fn(async () => PNG_BYTES);
    const ctx = makeCtx({ downloadAttachment });
    await handleDiscordMessage(
      msg({
        content: "",
        attachments: [
          attachment({
            filename: "huge.iso",
            size: DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES + 1,
          }),
        ],
      }),
      ctx,
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual([
      "Could not receive huge.iso: over the 50.0 MB inbound limit",
    ]);
  });

  it("drops attachments from anyone but the owner without touching the CDN", async () => {
    const downloadAttachment = vi.fn(async () => PNG_BYTES);
    const ctx = makeCtx({ downloadAttachment });
    await handleDiscordMessage(
      msg({
        author: { id: "impostor" },
        content: "",
        attachments: [attachment()],
      }),
      ctx,
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual([]);
  });
});
