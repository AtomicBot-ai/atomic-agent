import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleDiscordMessage,
  stripMention,
  type DiscordInboundContext,
  type DiscordMessageEvent,
} from "./discord-inbound-handler.js";

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

describe("reply attachments delivery", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-discord-reply-files-"));
    writeFileSync(join(dir, "report.pdf"), "pdf");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxReplying(text: string, attachments?: string[]) {
    const ctx = makeCtx();
    ctx.runTurn.mockImplementationOnce(
      async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
        opts.eventHook?.({
          type: "llm_event",
          event: {
            type: "assistant_reply",
            text,
            ...(attachments ? { attachments } : {}),
          },
        });
        return {};
      },
    );
    const files: Array<{ channelId: string; filename: string; afterTexts: number }> = [];
    const sendFile = vi.fn(async (channelId: string, file: { path: string; filename: string }) => {
      files.push({ channelId, filename: file.filename, afterTexts: ctx.sent.length });
      return "m2";
    });
    (ctx.api as unknown as { sendFile: unknown }).sendFile = sendFile;
    return Object.assign(ctx, { files, sendFile });
  }

  it("posts the reply text first, then each file as its own message", async () => {
    const ctx = ctxReplying("here it is", [join(dir, "report.pdf")]);
    await handleDiscordMessage(msg({ content: "send the report" }), ctx);
    expect(ctx.sent).toEqual(["here it is"]);
    expect(ctx.files).toEqual([{ channelId: "c1", filename: "report.pdf", afterTexts: 1 }]);
  });

  it("announces a file it could not deliver after the reply", async () => {
    const ctx = ctxReplying("here it is", [join(dir, "report.pdf"), join(dir, "gone.pdf")]);
    await handleDiscordMessage(msg({ content: "send both" }), ctx);
    expect(ctx.sent).toEqual(["here it is", "Could not send gone.pdf: file not found"]);
    expect(ctx.sendFile).toHaveBeenCalledTimes(1);
  });

  it("a reply without attachments never uploads anything", async () => {
    const ctx = ctxReplying("plain");
    await handleDiscordMessage(msg(), ctx);
    expect(ctx.sendFile).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual(["plain"]);
  });
});
