import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { callArgsSchemaValid } from "./step-batch-policy.js";

/**
 * Whether a batch whose JSON the parser had to repair may run (ATO-637).
 *
 * The parser fixes a few mechanical breakages (`repair-tool-call-json.ts`)
 * so a stray comma does not cost a whole repair completion. A repaired
 * batch is only as good as the guess behind it, so it runs only when
 * every call names a registered tool and its arguments satisfy that
 * tool's schema.
 *
 * Closing what the model left open is a guess about where it meant to
 * stop, so it is held to more:
 * - a string that had to be closed is never used: the value may be cut
 *   mid-way (`"path":"widget.txt` could have been `widget.txt.bak`),
 *   and a malformed call must not run (pinned in
 *   `native-tool-call-execution-integrity.test.ts`);
 * - brackets that had to be closed are not used when the completion was
 *   cut (`truncated`, `finish_reason: length`), nor for the tools that
 *   write file content, where half a file must never pass for a whole.
 * Fixes that change no value (a trailing comma, single quotes, a raw
 * newline, a code fence) are used whenever the schema check passes.
 * A refused repair goes the old way, to the one-shot repair completion.
 */

/** Tools whose arguments carry file content. */
export const CONTENT_WRITING_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
]);

export type RepairVerdict =
  | { accept: true }
  | { accept: false; reason: string };

export function judgeRepairedBatch(
  batch: ToolCallBatch,
  completion: Pick<CompletionResult, "truncated" | "finishReason">,
  registry: Pick<ToolRegistry, "has">,
  descriptors: readonly ToolDescriptor[],
): RepairVerdict {
  const repair = batch.jsonRepair;
  if (repair === undefined) return { accept: true };
  if (repair.closedString) {
    return { accept: false, reason: "a string was left open" };
  }
  const cut = completion.truncated || completion.finishReason === "length";
  if (repair.closedBrackets && cut) {
    return { accept: false, reason: "the completion was cut off" };
  }
  for (const call of batch.calls) {
    if (!registry.has(call.tool)) {
      return { accept: false, reason: `unknown tool '${call.tool}'` };
    }
    if (repair.closedBrackets && CONTENT_WRITING_TOOLS.has(call.tool)) {
      return {
        accept: false,
        reason: `'${call.tool}' was left unclosed`,
      };
    }
    if (!callArgsSchemaValid(call, descriptors)) {
      return {
        accept: false,
        reason: `'${call.tool}' arguments do not match its schema`,
      };
    }
  }
  return { accept: true };
}

/** The parse error a refused repair turns back into. */
export function repairRefusedError(reason: string): Error {
  return new Error(`invalid tool-call JSON (a mechanical repair was not used: ${reason})`);
}
