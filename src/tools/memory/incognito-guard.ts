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
 * Wrap a memory write tool so it refuses in an incognito chat and runs as
 * before everywhere else. The step says so on the call
 * (`ToolContext.incognito`, read off the session it runs on); the
 * optional `isIncognito` asks the store as well, for a caller that built
 * its own context. A throw from it counts as incognito, since writing
 * what the user asked not to keep is the worse mistake.
 */
export function refuseInIncognito(
  tool: ToolDefinition,
  isIncognito?: (sessionId: string) => boolean,
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
          output: INCOGNITO_MEMORY_WRITE_REFUSAL,
          details: { reason: "incognito_session" },
        });
      }
      return tool.run(args, ctx);
    },
  };
}
