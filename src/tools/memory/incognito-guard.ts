import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * The reply a memory write gets in an incognito chat (ATO-586). Says what
 * happened and what to tell the user, so the model does not retry or
 * claim it saved anything.
 */
export const INCOGNITO_MEMORY_WRITE_REFUSAL =
  "not saved: this is an incognito chat, so nothing from it is written to memory. " +
  "Tell the user it was not saved, and that a normal chat can save it.";

/**
 * The reply a memory read gets in an incognito chat (ATO-586, decision
 * 8): the chat neither learns from the conversation nor draws on what
 * earlier chats saved, so the recall tools find nothing to show it.
 */
export const INCOGNITO_MEMORY_READ_REFUSAL =
  "nothing recalled: this is an incognito chat, so saved memory is not read here. " +
  "Answer from this conversation alone; a normal chat can use saved memory.";

/**
 * The reply `tasks.schedule` / `tasks.cron` get in an incognito chat
 * (ATO-586): a task keeps its prompt in tasks.sqlite and runs it later in
 * an ordinary, listed chat, so the incognito chat would leave it behind.
 */
export const INCOGNITO_TASK_REFUSAL =
  "not scheduled: this is an incognito chat, so it cannot leave tasks behind. " +
  "Tell the user nothing was scheduled, and that a normal chat can schedule it.";

/**
 * Wrap a tool that would keep something from the chat (a memory write, a
 * scheduled task) so it refuses in an incognito chat and runs as
 * before everywhere else. The step says so on the call
 * (`ToolContext.incognito`, read off the session it runs on); the
 * optional `isIncognito` asks the store as well, for a caller that built
 * its own context. A throw from it counts as incognito, since writing
 * what the user asked not to keep is the worse mistake.
 */
export function refuseInIncognito(
  tool: ToolDefinition,
  isIncognito?: (sessionId: string) => boolean,
  refusal: string = INCOGNITO_MEMORY_WRITE_REFUSAL,
): ToolDefinition {
  return {
    ...tool,
    async run(args, ctx) {
      let incognito = ctx.incognito === true;
      if (!incognito && isIncognito) {
        try {
          incognito = isIncognito(ctx.sessionId);
        } catch {
          incognito = true;
        }
      }
      if (incognito) {
        return compressToolResult({
          tool: tool.name,
          status: "error",
          output: refusal,
          details: { reason: "incognito_session" },
        });
      }
      return tool.run(args, ctx);
    },
  };
}
