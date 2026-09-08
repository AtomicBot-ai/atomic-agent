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

function makeCtx(
  overrides: Partial<DiscordInboundContext> = {},
): DiscordInboundContext & {
  sent: string[];
  runTurn: ReturnType<typeof vi.fn>;
} {
  const sent: string[] = [];
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: {
    eventHook?: (e: unknown) => void;
  }) => {
    opts.eventHook?.({
      type: "llm_event",
      event: { type: "assistant_reply", text: "done" },
    });
    return {};
  });
  const ctx = {
    runtime: {
      runTurn,
      createSession: () => ({ id: "s1" }),
      sessionStore: { load: () => null },
    },
    api: {
      sendMessage: vi.fn(async (_c: string, text: string) => {
        sent.push(text);
        return "m1";
      }),
    },
    sessionPointer: {
      read: () => ({ current: null }),
      set: vi.fn(),
      rotate: vi.fn(),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ownerUserId: OWNER,
    botUserId: BOT,
    inflight: new Map(),
    inbox: createAttachmentInbox({ dir: inboxDir }),
    ...overrides,
  } as unknown as DiscordInboundContext;
  return Object.assign(ctx, { sent, runTurn });
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
    await handleDiscordMessage(
      msg({ author: { id: "222", bot: true } }),
      ctx,
    );
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
    expect(ctx.sent[0]).toBe("No turn in progress.");
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
    (ctx.runtime.runTurn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
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
    expect(message).toMatch(/^The user sent a file without a message\.\n\n\[attachments\]\n- /);
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
      msg({ content: "what is on this screenshot?", attachments: [attachment()] }),
      ctx,
    );
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message.startsWith("what is on this screenshot?\n\n[attachments]\n")).toBe(true);
    expect(message).toContain("vision.describe");
  });

  it("handles a guild @mention carrying a file", async () => {
    const ctx = makeCtx({ downloadAttachment: async () => PNG_BYTES });
    await handleDiscordMessage(
      msg({
        guild_id: "g1",
        content: `<@${BOT}> review this`,
        mentions: [{ id: BOT }],
        attachments: [attachment({ filename: "notes.txt", content_type: "text/plain" })],
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
        attachments: [attachment({ id: "1", filename: "a.png" }), attachment({ id: "2", filename: "b.png" })],
      }),
      ctx,
    );
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message).toMatch(/^The user sent 2 files without a message\./);
    expect(message.match(/^- .*-(a|b)\.png \(image\/png, 4 B\)$/gm)).toHaveLength(2);
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
    expect(ctx.sent[0]).toBe("Could not receive shot.png: Discord CDN returned HTTP 404");
    expect(ctx.runTurn).toHaveBeenCalledOnce();
    const message = ctx.runTurn.mock.calls[0]![1];
    expect(message).toContain("summarise");
    expect(message).toContain("- shot.png: not saved (Discord CDN returned HTTP 404)");
  });

  it("a failed download with no text ends at the notice", async () => {
    const ctx = makeCtx({
      downloadAttachment: async () => {
        throw new Error("boom");
      },
    });
    await handleDiscordMessage(msg({ content: "", attachments: [attachment()] }), ctx);
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
          attachment({ filename: "huge.iso", size: DISCORD_ATTACHMENT_DOWNLOAD_LIMIT_BYTES + 1 }),
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
      msg({ author: { id: "impostor" }, content: "", attachments: [attachment()] }),
      ctx,
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual([]);
  });
});
