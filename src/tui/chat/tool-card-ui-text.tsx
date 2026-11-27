import { Text } from "ink";
import type { ReactElement } from "react";
import { UI_RENDER_NEXT, UI_RENDER_TOOL } from "../../tools/ui/index.js";
import { theme } from "../theme/theme.js";

/**
 * The terminal's form of a `ui.render` card (ATO-2457). The desktop draws
 * the buttons, the form or the cards; here the closed tool card prints the
 * call's whole text form (ui-render-text.ts) instead of its one-line
 * preview, so the person reads every option and answers by typing (a
 * number or words). The line meant for the model is left out.
 * `estimateToolCardHeight` already charges one row per summary line.
 */
export function isUiRenderCard(card: { tool: string; status?: string }): boolean {
  return card.tool === UI_RENDER_TOOL && card.status === "ok";
}

/** The lines the person sees: the summary without the model's "what next" line. */
export function uiCardLines(summary: string): string[] {
  return summary.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== UI_RENDER_NEXT && line.length > 0);
}

export function ToolCardUiText({ summary, color }: { summary: string; color: string }): ReactElement {
  const lines = uiCardLines(summary);
  return (
    <>
      {lines.map((line, idx) => (
        <Text key={`ui-${idx}`} color={idx === 0 ? color : undefined}>
          {idx === lines.length - 1 ? theme.glyphs.toolBoxBottomLeft : " "}
          {idx === lines.length - 1 ? theme.glyphs.toolBoxHorizontal : " "} {line}
        </Text>
      ))}
    </>
  );
}
