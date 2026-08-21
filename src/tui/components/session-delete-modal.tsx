import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import type { SessionDeleteConfirm } from "../tui-state.js";

/** Popup width, clamped to the pane on narrow windows. */
const PREFERRED_WIDTH = 48;

interface SessionDeleteModalProps {
  confirm: SessionDeleteConfirm;
  /** Rows available in the pane the dialog floats over. */
  availableRows: number;
  /** Columns available in that pane. */
  availableColumns: number;
  onConfirm: (sessionId: string) => void;
  onCancel: () => void;
  onFocus: (cursor: "yes" | "cancel") => void;
}

/**
 * "Delete the session?" — the same surface as the operator menu: a
 * painted panel centred in the content pane, the app dimmed behind it,
 * and the same mouse contract (click a control, click outside to
 * dismiss, wheel swallowed rather than scrolling the transcript
 * underneath).
 *
 * The two controls are deliberately unlike each other. `Yes` is the
 * raised chip the composer uses for Send — the affirmative control
 * everywhere else in the app. `Cancel` is the same footprint drawn as
 * an outline: a frame in the panel's own foreground with no fill, which
 * is what "secondary" looks like when a terminal has no greys to spend.
 * The cursor still starts on Cancel: Enter on a dialog nobody read must
 * not delete a thread.
 */
export function SessionDeleteModal({
  confirm,
  availableRows,
  availableColumns,
  onConfirm,
  onCancel,
  onFocus,
}: SessionDeleteModalProps): ReactElement {
  const width = Math.max(24, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  const inner = width - 2;
  // Title, blank, preview, blank, the button row, plus two border rows.
  const height = 7;
  const offsetTop = Math.max(0, Math.floor((availableRows - height) / 2));
  const offsetLeft = Math.max(0, Math.floor((availableColumns - width) / 2));
  // Same trick as the menu: the ref rides the absolutely-positioned
  // panel itself, so no wrapper Box can displace the offsets. Presses
  // are claimed and dropped so a click on the panel's own chrome cannot
  // fall through to the backdrop and dismiss it.
  const ref = useMouseTarget(
    (hit) => {
      if (hit.event.kind === "wheel") return true;
      return isPrimaryPress(hit.event);
    },
    { layer: MOUSE_LAYER_MODAL },
  );
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={offsetTop}
      marginLeft={offsetLeft}
      borderStyle="round"
      borderColor={chromeTheme.colors.railMuted}
      backgroundColor={chromeTheme.colors.railBackground}
      width={width}
      flexDirection="column"
    >
      <Text color={chromeTheme.colors.railForeground} bold>
        {fit(" DELETE THE SESSION?", inner)}
      </Text>
      <Text>{fit("", inner)}</Text>
      <Text color={chromeTheme.colors.railForeground}>
        {fit(` ${confirm.preview}`, inner)}
      </Text>
      <Text>{fit("", inner)}</Text>
      <Box width={inner}>
        <Text>{" "}</Text>
        <ConfirmButton
          label="Yes"
          tone="primary"
          focused={confirm.cursor === "yes"}
          onPress={() => onConfirm(confirm.sessionId)}
          onFocus={() => onFocus("yes")}
        />
        <Text>{"  "}</Text>
        <ConfirmButton
          label="Cancel"
          tone="outline"
          focused={confirm.cursor === "cancel"}
          onPress={onCancel}
          onFocus={() => onFocus("cancel")}
        />
      </Box>
    </Box>
  );
}

/**
 * One dialog control.
 *
 * `primary` is the composer's Send chip — a light face under dark text,
 * the affirmative control everywhere else in the app. `outline` is the
 * same label inside a bracket frame with no fill: brackets rather than
 * a bordered Box because Ink draws a border on its own rows, which
 * would make a two-button row three rows tall and push the dialog out
 * of shape. On one line, `[ Cancel ]` is what a frame looks like.
 *
 * Focus is a leading chevron, not a colour: the panel is painted, so a
 * colour change is quiet against it, and under NO_COLOR it says nothing
 * at all. The chevron is the same cursor mark the rail and the menu use.
 */
function ConfirmButton({
  label,
  tone,
  focused,
  onPress,
  onFocus,
}: {
  label: string;
  tone: "primary" | "outline";
  focused: boolean;
  onPress: () => void;
  onFocus: () => void;
}): ReactElement {
  const marker = focused ? chromeTheme.glyphs.chevronRight : " ";
  const body = (
    <>
      <Text color={chromeTheme.colors.railForeground} bold>
        {marker}
      </Text>
      {tone === "primary" ? (
        <Text
          color={chromeTheme.colors.chipForeground}
          backgroundColor={chromeTheme.colors.chipBackground}
          bold
        >
          {` ${label} `}
        </Text>
      ) : (
        <Text color={chromeTheme.colors.railForeground} bold={focused}>
          {`[ ${label} ]`}
        </Text>
      )}
    </>
  );
  const mouse = useMouseCommands();
  if (!mouse) return <Box flexShrink={0}>{body}</Box>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onFocus();
        onPress();
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}

/** Pad or truncate to exactly `width` columns, so the panel is opaque. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length > width) {
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  }
  return text.padEnd(width);
}
