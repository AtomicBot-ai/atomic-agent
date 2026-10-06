import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";

interface ChatSwitchBackButtonProps {
  /** The thread the notice is about — what the click opens. */
  readonly sessionId: string;
}

/**
 * The affordance on a notice about a backgrounded turn: go back to it.
 *
 * Switching threads mid-turn leaves three notices behind, and every one
 * of them ends by telling the operator to go somewhere: "switch back to
 * watch or stop it", "open it from the sidebar to read the reply",
 * "background turn on session … failed". The notice knows exactly which
 * session it means — it prints the id — while the operator has to carry
 * that id to the rail or the picker and match it by eye against a list
 * of threads labelled by their first prompt. Naming a destination and
 * making the reader navigate to it by hand is half a message.
 *
 * Goes through `onSessionSwitchRequested`, the same callback the rail's
 * rows and the picker's Enter use, so the click inherits the whole
 * switch: the parked abort handle is re-attached, the replay repaints
 * what the turn said while away, a pending approval is re-raised. A
 * second path into a session is how two of them come to disagree.
 *
 * A labelled button rather than a clickable notice: a click anywhere in
 * a transcript is how one scrolls and selects text, and a stray press
 * that silently teleports the operator into another thread mid-draft is
 * worse than no shortcut at all. This also names the action.
 *
 * Without a mouse provider it still renders — the same call `[copy]`
 * makes — so the affordance is legible under `--no-mouse`, where the
 * sessions rail is the way there.
 */
export function ChatSwitchBackButton({
  sessionId,
}: ChatSwitchBackButtonProps): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text color={theme.colors.muted} dimColor>
      [switch back]
    </Text>
  );
  if (!mouse) return <Box marginLeft={1}>{label}</Box>;
  return (
    <Box marginLeft={1} flexDirection="row">
      <MouseTarget
        flexShrink={0}
        onMouse={(hit) => {
          if (!isPrimaryPress(hit.event)) return false;
          // Claim the press either way — the click landed on this
          // button, and letting it fall through would hand it to the
          // viewport wheel target behind the chat log.
          mouse.callbacks.onSessionSwitchRequested?.(sessionId);
          return true;
        }}
      >
        {label}
      </MouseTarget>
    </Box>
  );
}
