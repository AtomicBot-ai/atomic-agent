import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { parseUiSpec, UI_KINDS, type UiSpec } from "./ui-render-spec.js";
import { UI_RENDER_NEXT, uiSpecText } from "./ui-render-text.js";

export const UI_RENDER_TOOL = "ui.render";
/** Key of the spec in the result's `details`, read by `uiSpecOf`. */
export const UI_DETAIL = "ui";

/**
 * `ui.render { kind, title, text?, options? | fields? + submit? | cards? }`
 * (ATO-2457): a ready component in the chat, drawn by the host itself.
 * The desktop draws a decision's buttons, a form or cards with its own
 * DOM, no iframe and no script of the model's; a click puts the answer in
 * the person's message box, and they press Enter (or, with "Widgets send
 * right away" on, it goes at once). The terminal prints the text form.
 *
 * It does not wait: unlike `ask_user` the turn goes on, and the answer is
 * the person's next message. Writes nothing, asks nothing, so it is
 * read-only and runs in plan mode too, like `plan.update`.
 *
 * Precedents: OpenClaw's show-widget and Claude's interactive widgets
 * (a click becomes the next prompt), ChatGPT Apps' inline cards.
 */
export const uiRenderTool: ToolDefinition = {
  name: UI_RENDER_TOOL,
  description:
    `Show the user a ready component in the chat: ${UI_KINDS.join(", ")}. A click or a filled form becomes the user's next message.`,
  readonly: true,
  async run(rawArgs): Promise<CompressedToolResult> {
    let spec: UiSpec;
    try {
      spec = parseUiSpec(rawArgs);
    } catch (err) {
      return compressToolResult({ tool: UI_RENDER_TOOL, status: "error", output: `ui.render: ${(err as Error).message}` });
    }
    return compressToolResult(
      { tool: UI_RENDER_TOOL, status: "ok", output: `${uiSpecText(spec)}\n${UI_RENDER_NEXT}`, details: { [UI_DETAIL]: spec } },
      // The whole text fits: the default keeps only the last 12 lines.
      { maxTailLines: 60, maxSummaryLength: 8_000 },
    );
  },
};

/**
 * The spec an ok `ui.render` call showed, for the stream to hand the host
 * as `ui` on the call's `tool_result` frame. The parser already checked
 * it; this only makes sure the record is the tool's own. Undefined for
 * any other call or a failed one.
 */
export function uiSpecOf(result: CompressedToolResult): UiSpec | undefined {
  if (result.tool !== UI_RENDER_TOOL || result.status !== "ok") return undefined;
  const raw = (result.details ?? {})[UI_DETAIL];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const spec = raw as UiSpec;
  if (!(UI_KINDS as readonly string[]).includes(spec.kind) || typeof spec.title !== "string") return undefined;
  return spec;
}
