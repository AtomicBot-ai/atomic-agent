import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

/** The three dispatches that put the operator on the Fallback pane. */
export const CONFIGURE_FALLBACK_ACTIONS = [
  { type: "ui_mode_set", mode: "debug" },
  { type: "tab_changed", tab: "llm" },
  { type: "llm_mode_set", mode: "fallback" },
] as const;

/**
 * The affordance on a fallover notice: go and change the order.
 *
 * A notice that says "openrouter refused, answering from local-llama"
 * hands the operator a decision — accept it, put a different provider
 * next, or take the local one out of the chain — and the pane that
 * makes that decision is four keystrokes and one piece of knowledge
 * away (`/llm`, then the Fallback pane, which most operators have never
 * opened). Telling someone their model changed and leaving the fix
 * undiscoverable is half a message.
 *
 * Deep-links rather than opening a modal over the chat: the chain is
 * edited in the Fallback pane, and a second editor for the same config
 * is how two writers of `llm.fallback` come to disagree.
 *
 * Without a mouse provider it still renders — the same call `[copy]`
 * makes — so the affordance is legible under `--no-mouse`, where `/llm`
 * is the way there.
 */
export function ChatConfigureFallbackButton(): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text color={theme.colors.muted} dimColor>
      [configure fallback]
    </Text>
  );
  if (!mouse) return <Box marginLeft={1}>{label}</Box>;
  return (
    <Box marginLeft={1} flexDirection="row">
      <MouseTarget
        flexShrink={0}
        onMouse={(hit) => {
          if (!isPrimaryPress(hit.event)) return false;
          for (const action of CONFIGURE_FALLBACK_ACTIONS) {
            mouse.dispatch({ ...action });
          }
          return true;
        }}
      >
        {label}
      </MouseTarget>
    </Box>
  );
}
