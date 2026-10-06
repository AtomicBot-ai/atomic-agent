import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { LinkifiedText } from "../render/linkify-text.js";
import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";

interface UserBubbleProps {
  text: string;
  /**
   * The Fusion run mode is on: the border takes the palette's orange.
   * The `YOU` label keeps the user colour — the human did not change,
   * the mode the message is answered under did.
   */
  fusion?: boolean;
  /**
   * The message was folded into a turn already running. The label says
   * so, because the reply under it answers that turn's opening request.
   */
  steered?: boolean;
  /**
   * Sent into the running turn but not folded in yet — the loop reads
   * its inbox at the next step boundary. Drawn at the foot of the chat,
   * dimmed and labelled as on its way in, because this one is not in
   * the transcript and may still end up parked as the next turn.
   */
  pending?: boolean;
}

/**
 * A user message: a `YOU` label over a coloured left border and
 * generous vertical padding around the body. `marginTop=1` between
 * messages prevents bubbles from touching.
 *
 * The label used to be absent, on the theory that the border colour is
 * the label. Colour alone says nothing under NO_COLOR, in a pipe, or to
 * a reader who cannot separate the two hues — and the design puts the
 * word back, which is also the accessible answer.
 *
 * No markdown rendering — the user authored the text and expects to
 * see exactly what they typed.
 */
export function UserBubble({
  text,
  fusion = false,
  steered = false,
  pending = false,
}: UserBubbleProps): ReactElement {
  // `pending` outranks `steered`: both describe the same message, and
  // until the loop takes it the honest label is the one that says so.
  const label = pending
    ? `  YOU${PENDING_STEER_LABEL_SUFFIX}`
    : steered
      ? `  YOU${STEERED_LABEL_SUFFIX}`
      : "  YOU";
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={pending ? theme.colors.muted : theme.colors.user} bold>
        {label}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={
          pending
            ? theme.colors.muted
            : fusion
              ? fusionInk()
              : theme.colors.user
        }
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        {splitLines(text).map((line, idx) => (
          <Text key={idx}>
            <LinkifiedText text={line} />
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Label tail on a message folded into the running turn. */
export const STEERED_LABEL_SUFFIX = " · steered into the running turn";

/**
 * Label tail on a steer that has been accepted but not read yet. Says
 * when it will be, in the same words the runtime acknowledgement uses,
 * because "nothing has happened yet" is exactly the moment an operator
 * assumes the message was swallowed and types it again.
 */
export const PENDING_STEER_LABEL_SUFFIX =
  " · steering — the agent reads it at the next step";

function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  return text.replace(/\r\n/g, "\n").split("\n");
}
