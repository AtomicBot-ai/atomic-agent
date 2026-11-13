/**
 * The `/atomic <command>` slash command (ATO-499).
 *
 * Slack keeps every message that starts with `/` for its own commands,
 * so `!new` typed as text is the fallback and `/atomic new` is the
 * native form. Socket Mode delivers the command as a `slash_commands`
 * envelope (acknowledged by the socket); this module routes it to the
 * same command handler as `!`, and anything that is not a command goes
 * to the agent as a message, exactly like `!something-else`.
 *
 * A slash command carries no thread, so it acts on the DM's session or,
 * in a channel, on the channel-level conversation (the one top-level
 * mentions use with `threadReplies` off). To act on a thread, type the
 * `!` form inside it. Replies go to the channel or DM it was invoked in.
 */

import { SlackApiError, type SlackApi } from "./slack-api.js";
import {
  dispatchToRuntime,
  handleCommand,
  type SlackInboundContext,
  type SlackRef,
} from "./slack-inbound-handler.js";
import { scrubSlackError } from "./slack-types.js";

/** The fields of a `slash_commands` payload this channel reads. */
export interface SlackSlashCommandPayload {
  command?: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  response_url?: string;
}

export type SlackSlashContext = SlackInboundContext & {
  api: Pick<SlackApi, "postText" | "respond">;
};

/** Entry point for one slash command. Always resolves; never throws. */
export async function handleSlackSlashCommand(
  payload: SlackSlashCommandPayload,
  ctx: SlackSlashContext,
): Promise<void> {
  try {
    await route(payload, ctx);
  } catch (err) {
    ctx.logger.warn("slack: slash command failed", { error: scrubSlackError(err) });
  }
}

async function route(payload: SlackSlashCommandPayload, ctx: SlackSlashContext): Promise<void> {
  const user = payload.user_id;
  const channel = payload.channel_id;
  if (typeof user !== "string" || typeof channel !== "string") return;
  if (!ctx.ownerIds.includes(user)) {
    ctx.logger.warn("slack: refusing slash command from non-owner", {
      userId: user,
      ownerConfigured: ctx.ownerIds.length > 0,
    });
    // Through `response_url`: it is ephemeral by default and works in
    // channels the bot was never invited to, where chat.postEphemeral
    // would fail with not_in_channel.
    if (typeof payload.response_url === "string") {
      await quietly(ctx, () =>
        ctx.api.respond(payload.response_url!, "Only a paired operator can use this command."),
      );
    }
    return;
  }
  const isDm = channel.startsWith("D");
  const ref: SlackRef = {
    key: isDm ? `dm:${channel}` : channel,
    target: { channel },
    isDm,
    label: isDm ? "DM" : `channel ${channel}`,
  };
  const replyCtx = withResponseUrlFallback(ctx, payload.response_url);
  const text = (payload.text ?? "").trim();
  const [verb = "help", ...rest] = text.length > 0 ? text.split(/\s+/) : [];
  if (await handleCommand(verb.replace(/^[/!]/, "").toLowerCase(), rest.join(" "), ref, replyCtx)) return;
  await dispatchToRuntime(text, ref, replyCtx);
}

/** chat.postMessage errors that mean "the bot cannot post in this channel". */
const NOT_A_MEMBER: ReadonlySet<string> = new Set(["not_in_channel", "channel_not_found"]);

/**
 * A slash command works in any channel, but the bot can only post where
 * it was invited. When chat.postMessage says so, the reply goes back
 * through `response_url` instead (ephemeral, seen by the owner only),
 * with a hint on how to get replies in the channel itself.
 */
function withResponseUrlFallback(ctx: SlackSlashContext, responseUrl: string | undefined): SlackSlashContext {
  if (typeof responseUrl !== "string") return ctx;
  const hint = `_Invite <@${ctx.botUserId}> to this channel to get replies here._`;
  return {
    ...ctx,
    // Methods, not a spread: SlackApi's methods live on its prototype.
    api: {
      respond: (url, text) => ctx.api.respond(url, text),
      postText: async (target, text) => {
        try {
          await ctx.api.postText(target, text);
        } catch (err) {
          if (!(err instanceof SlackApiError) || !NOT_A_MEMBER.has(err.code)) throw err;
          await ctx.api.respond(responseUrl, `${text}\n${hint}`);
        }
      },
    },
  };
}

async function quietly(ctx: SlackSlashContext, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.logger.warn("slack: slash command reply failed", { error: scrubSlackError(err) });
  }
}
