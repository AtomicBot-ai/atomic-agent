import { describe, expect, it, vi } from "vitest";

import { SlackApiError } from "./slack-api.js";
import { handleSlackEvent } from "./slack-inbound-handler.js";
import { handleSlackSlashCommand, type SlackSlashContext } from "./slack-slash-command.js";
import type { SlackTarget } from "./slack-types.js";

const OWNER = "UOWNER";

function makeCtx(over: Partial<SlackSlashContext> = {}) {
  const posted: Array<{ target: SlackTarget; text: string }> = [];
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "ok" } });
    return {};
  });
  const chats = new Map<string, { current: string | null }>();
  const ctx: SlackSlashContext = {
    runtime: {
      runTurn,
      createSession: vi.fn(() => ({ id: "s1" })),
      sessionStore: { load: (id: string) => ({ id }) },
    } as never,
    api: {
      postText: vi.fn(async (target: SlackTarget, text: string) => {
        posted.push({ target, text });
      }),
      respond: vi.fn(async () => {}),
    },
    sessions: {
      get: (k: string) => chats.get(k) ?? { current: null },
      setCurrent: vi.fn((k: string, id: string) => chats.set(k, { current: id })),
      rotate: vi.fn(),
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ownerIds: [OWNER],
    botUserId: "UBOT",
    threadReplies: true,
    inflight: new Map(),
    seen: new Set(),
    ...over,
  };
  return { ctx, posted, runTurn };
}

const slash = (text: string, over: Record<string, unknown> = {}) => ({
  command: "/atomic",
  text,
  user_id: OWNER,
  channel_id: "D1",
  response_url: "https://hooks.slack.com/commands/T1/1/x",
  ...over,
});

describe("handleSlackSlashCommand", () => {
  it("/atomic help gives the same reply as !help", async () => {
    const viaSlash = makeCtx();
    await handleSlackSlashCommand(slash("help"), viaSlash.ctx);
    const viaBang = makeCtx();
    await handleSlackEvent(
      { type: "message", channel_type: "im", channel: "D1", user: OWNER, text: "!help", ts: "1.0" },
      viaBang.ctx,
    );
    expect(viaSlash.posted).toHaveLength(1);
    expect(viaSlash.posted[0]?.text).toBe(viaBang.posted[0]?.text);
    // Replies where it was invoked: the DM itself, no thread.
    expect(viaSlash.posted[0]?.target).toEqual({ channel: "D1" });
  });

  it("a bare /atomic shows the help", async () => {
    const { ctx, posted } = makeCtx();
    await handleSlackSlashCommand(slash(""), ctx);
    expect(posted[0]?.text).toMatch(/Atomic Agent on Slack/);
  });

  it("/atomic status reads the DM session", async () => {
    const { ctx, posted } = makeCtx();
    await handleSlackSlashCommand(slash("hello", { text: "fix it" }), ctx);
    await handleSlackSlashCommand(slash("status"), ctx);
    expect(posted.at(-1)?.text).toMatch(/session `s1`/);
  });

  it("text that is not a command goes to the agent", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleSlackSlashCommand(slash("fix the build", { channel_id: "C1" }), ctx);
    expect(runTurn.mock.calls[0]?.[1]).toBe("fix the build");
    expect(posted.at(-1)).toEqual({ target: { channel: "C1" }, text: "ok" });
  });

  it("a non-owner gets an ephemeral refusal and nothing runs", async () => {
    const { ctx, runTurn, posted } = makeCtx();
    await handleSlackSlashCommand(slash("help", { user_id: "USTRANGER" }), ctx);
    expect(runTurn).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
    expect(ctx.api.respond).toHaveBeenCalledWith(
      "https://hooks.slack.com/commands/T1/1/x",
      expect.stringMatching(/Only a paired operator/),
    );
  });

  it("falls back to response_url when the bot is not in the channel", async () => {
    for (const code of ["not_in_channel", "channel_not_found"]) {
      const { ctx } = makeCtx();
      ctx.api.postText = vi.fn(async () => {
        throw new SlackApiError(code);
      });
      await handleSlackSlashCommand(slash("status", { channel_id: "C9" }), ctx);
      expect(ctx.api.respond).toHaveBeenCalledWith(
        "https://hooks.slack.com/commands/T1/1/x",
        expect.stringMatching(/No session here yet\.\n.*Invite <@UBOT> to this channel to get replies here/),
      );
    }
  });

  it("does not use response_url for other posting errors", async () => {
    const { ctx } = makeCtx();
    ctx.api.postText = vi.fn(async () => {
      throw new SlackApiError("ratelimited");
    });
    await handleSlackSlashCommand(slash("status", { channel_id: "C9" }), ctx);
    expect(ctx.api.respond).not.toHaveBeenCalled();
  });

  it("refuses everyone when no owner is configured", async () => {
    const { ctx, runTurn } = makeCtx({ ownerIds: [] });
    await handleSlackSlashCommand(slash("fix it"), ctx);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
