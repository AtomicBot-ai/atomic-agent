import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { fitToWidth } from "../components/fit-to-width.js";
import { wrapText } from "../render/wrap-text.js";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import { DESKTOP_DATA_QUESTION } from "../../uninstall/index.js";
import {
  isUninstallConfirmed,
  UNINSTALL_CONFIRM_WORD,
  type UninstallFlowState,
} from "./uninstall-state.js";

const PREFERRED_WIDTH = 64;
/** Target rows at most before the list is summarised. */
const MAX_ROWS = 7;

interface UninstallModalProps {
  flow: UninstallFlowState;
  availableRows: number;
  availableColumns: number;
  onCancel: () => void;
  onContinue: () => void;
  onFocus: (cursor: "continue" | "cancel") => void;
  /** `desktop` step: a click focused one of its two buttons. */
  onDesktopFocus?: (cursor: "keep" | "delete") => void;
  /** `desktop` step: a click answered the question. */
  onDesktopAnswer?: (answer: "keep" | "delete") => void;
}

/**
 * The uninstall ladder: one panel, three screens, and no way to reach
 * the last one by holding Enter.
 *
 * The design brief for this dialog is the opposite of every other one
 * in the app. Elsewhere the job is to get out of the way; here the job
 * is to be *in* the way exactly as long as it takes for the operator to
 * read what is about to be deleted off their own disk. So: the review
 * screen names every path with its real size, the cursor starts on
 * Cancel, continuing costs a deliberate ← → move, and the screen after
 * it will not arm until the word `uninstall` has been typed out in
 * full. Three separate refusals to guess what the operator meant.
 */
export function UninstallModal({
  flow,
  availableRows,
  availableColumns,
  onCancel,
  onContinue,
  onFocus,
  onDesktopFocus,
  onDesktopAnswer,
}: UninstallModalProps): ReactElement {
  const width = Math.max(32, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  const inner = width - 2;
  const body = bodyLines(flow, inner);
  const height = body.length + 4;
  const offsetTop = Math.max(0, Math.floor((availableRows - height) / 2));
  const offsetLeft = Math.max(0, Math.floor((availableColumns - width) / 2));
  const ref = useMouseTarget(
    (hit) => {
      // Wheel is swallowed rather than scrolling the transcript behind a
      // dialog that is asking a question about deleting it.
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
      borderColor={chromeTheme.colors.error}
      backgroundColor={chromeTheme.colors.railBackground}
      width={width}
      flexDirection="column"
    >
      <Text color={chromeTheme.colors.error} bold>
        {fitToWidth(` ${title(flow)}`, inner)}
      </Text>
      {body.map((line, idx) => (
        <Text
          key={`u-${idx}`}
          color={
            line.tone === "warn"
              ? chromeTheme.colors.error
              : line.tone === "muted"
                ? chromeTheme.colors.railMuted
                : chromeTheme.colors.railForeground
          }
          bold={line.tone === "warn"}
        >
          {fitToWidth(line.text, inner)}
        </Text>
      ))}
      <Footer
        flow={flow}
        inner={inner}
        onCancel={onCancel}
        onContinue={onContinue}
        onFocus={onFocus}
        onDesktopFocus={onDesktopFocus}
        onDesktopAnswer={onDesktopAnswer}
      />
    </Box>
  );
}

interface BodyLine {
  readonly text: string;
  readonly tone: "normal" | "muted" | "warn";
}

function title(flow: UninstallFlowState): string {
  switch (flow.step) {
    case "loading":
      return "UNINSTALL ATOMIC-AGENT — READING DISK…";
    case "review":
      return "UNINSTALL ATOMIC-AGENT — THIS DELETES DATA";
    case "confirm":
      return "UNINSTALL ATOMIC-AGENT — LAST CHANCE";
    case "desktop":
      return "UNINSTALL ATOMIC-AGENT: DESKTOP APP DATA";
    case "closing":
      return "UNINSTALLING…";
    case "failed":
      return "UNINSTALL — COULD NOT READ THE PLAN";
  }
}

/**
 * The panel's interior, as tone-tagged lines. Split out so the wording
 * — which is the entire safety mechanism here — is asserted by a test
 * rather than eyeballed in a screenshot.
 */
export function bodyLines(
  flow: UninstallFlowState,
  inner: number,
): readonly BodyLine[] {
  switch (flow.step) {
    case "loading":
      return [{ text: " measuring what is on disk…", tone: "muted" }];
    case "failed":
      return flow.errors.map((error) => ({
        text: ` ${error}`,
        tone: "warn" as const,
      }));
    case "closing":
      return [
        { text: "", tone: "muted" },
        { text: " shutting the agent down first…", tone: "muted" },
        {
          text: " the removal runs once the terminal is back.",
          tone: "muted",
        },
        { text: "", tone: "muted" },
      ];
    case "review":
      return reviewLines(flow, inner);
    case "confirm":
      return confirmLines(flow, inner);
    case "desktop":
      return desktopLines(flow, inner);
  }
}

function reviewLines(
  flow: UninstallFlowState,
  inner: number,
): readonly BodyLine[] {
  const preview = flow.preview;
  if (!preview || preview.rows.length === 0) {
    return [
      { text: "", tone: "muted" },
      { text: " nothing to remove — no install found here.", tone: "muted" },
      { text: "", tone: "muted" },
    ];
  }
  const lines: BodyLine[] = [{ text: "", tone: "muted" }];
  const shown = preview.rows.slice(0, MAX_ROWS);
  for (const row of shown) {
    const size = ` ${row.size}`;
    const path = fitToWidth(
      ` ${row.path}`,
      Math.max(0, inner - size.length - 1),
    );
    lines.push({ text: `${path}${size}`, tone: "normal" });
    if (row.warning) lines.push(...wrapped(row.warning, inner, "warn"));
  }
  const hidden = preview.rows.length - shown.length;
  if (hidden > 0) {
    lines.push({ text: `  …and ${hidden} more`, tone: "muted" });
  }
  lines.push({ text: "", tone: "muted" });
  lines.push({ text: ` total: ${preview.total}`, tone: "normal" });
  if (preview.devCheckout) {
    lines.push({
      text: " no installed binary here — data only.",
      tone: "muted",
    });
  }
  for (const notice of preview.leftInPlace ?? []) {
    lines.push(...wrapped(notice, inner, "muted"));
  }
  lines.push({ text: "", tone: "muted" });
  lines.push({
    text: " This cannot be undone. There is no backup.",
    tone: "warn",
  });
  lines.push({
    text: " Memory, sessions and models go with it.",
    tone: "warn",
  });
  lines.push({ text: "", tone: "muted" });
  return lines;
}

/** A sentence soft-wrapped into the panel, one leading space per row. */
function wrapped(
  text: string,
  inner: number,
  tone: BodyLine["tone"],
): BodyLine[] {
  return wrapText(text, Math.max(1, inner - 2)).map((row) => ({
    text: ` ${row}`,
    tone,
  }));
}

function confirmLines(
  flow: UninstallFlowState,
  inner: number,
): readonly BodyLine[] {
  const armed = isUninstallConfirmed(flow.typed);
  // The desktop warning is repeated here: this is the screen the
  // operator acts on, and the review screen may have scrolled past.
  const desktopWarning = flow.preview?.rows.find((row) => row.warning)?.warning;
  return [
    { text: "", tone: "muted" },
    {
      text: ` Deleting ${flow.preview?.total ?? "everything"} permanently.`,
      tone: "warn",
    },
    ...(desktopWarning ? wrapped(desktopWarning, inner, "warn") : []),
    ...(flow.preview?.desktopSharedDir
      ? wrapped(DESKTOP_QUESTION_NEXT, inner, "muted")
      : []),
    { text: "", tone: "muted" },
    {
      text: ` Type ${UNINSTALL_CONFIRM_WORD} to enable the last key:`,
      tone: "normal",
    },
    {
      // A caret and the letters so far. The field is never pre-filled
      // and never autocompletes: the typing IS the confirmation.
      text: ` ${chromeTheme.glyphs.promptCaret} ${flow.typed}`,
      tone: armed ? "warn" : "muted",
    },
    { text: "", tone: "muted" },
  ];
}

/** Said on the last-chance screen when the desktop question follows. */
const DESKTOP_QUESTION_NEXT =
  "Next you choose whether the desktop app's data in this folder goes too.";

/**
 * The separate question about a state folder the desktop app shares.
 * Keep is the default and removes only the terminal program.
 */
function desktopLines(
  flow: UninstallFlowState,
  inner: number,
): readonly BodyLine[] {
  const dir = flow.preview?.desktopSharedDir ?? "";
  return [
    { text: "", tone: "muted" },
    ...wrapped(DESKTOP_DATA_QUESTION, inner, "warn"),
    { text: "", tone: "muted" },
    { text: fitToWidth(` ${dir}`, inner), tone: "normal" },
    { text: "", tone: "muted" },
    ...wrapped(
      "Keep data: remove only the terminal program. The desktop app keeps working.",
      inner,
      "normal",
    ),
    ...wrapped(
      "Delete too: the folder goes, and the desktop app starts from scratch.",
      inner,
      "normal",
    ),
    { text: "", tone: "muted" },
  ];
}

/** Legal moves for the current step, plus the two-button steps. */
function Footer({
  flow,
  inner,
  onCancel,
  onContinue,
  onFocus,
  onDesktopFocus,
  onDesktopAnswer,
}: {
  flow: UninstallFlowState;
  inner: number;
  onCancel: () => void;
  onContinue: () => void;
  onFocus: (cursor: "continue" | "cancel") => void;
  onDesktopFocus?: (cursor: "keep" | "delete") => void;
  onDesktopAnswer?: (answer: "keep" | "delete") => void;
}): ReactElement {
  if (flow.step === "desktop") {
    return (
      <Box width={inner}>
        <Text> </Text>
        {/* Same reversal as review: the raised chip is the safe answer. */}
        <DialogButton
          label="Keep data"
          tone="primary"
          focused={flow.desktopCursor === "keep"}
          onPress={() => onDesktopAnswer?.("keep")}
          onFocus={() => onDesktopFocus?.("keep")}
        />
        <Text>{"  "}</Text>
        <DialogButton
          label="Delete too"
          tone="outline"
          focused={flow.desktopCursor === "delete"}
          onPress={() => onDesktopAnswer?.("delete")}
          onFocus={() => onDesktopFocus?.("delete")}
        />
      </Box>
    );
  }
  if (flow.step === "review" && (flow.preview?.rows.length ?? 0) > 0) {
    return (
      <Box width={inner}>
        <Text> </Text>
        <DialogButton
          label="Cancel"
          tone="primary"
          focused={flow.cursor === "cancel"}
          onPress={onCancel}
          onFocus={() => onFocus("cancel")}
        />
        <Text>{"  "}</Text>
        {/*
          Continue is the *outline* control and Cancel is the raised
          chip — the reverse of every other dialog in the app. The chip
          is what the eye lands on and the thumb reaches for, and on
          this dialog the safe answer is the one that should get that.
        */}
        <DialogButton
          label="Continue"
          tone="outline"
          focused={flow.cursor === "continue"}
          onPress={onContinue}
          onFocus={() => onFocus("continue")}
        />
      </Box>
    );
  }
  return (
    <Text color={chromeTheme.colors.railMuted}>
      {fitToWidth(` ${hint(flow)}`, inner)}
    </Text>
  );
}

function hint(flow: UninstallFlowState): string {
  switch (flow.step) {
    case "confirm":
      return isUninstallConfirmed(flow.typed)
        ? "enter uninstall   esc cancel"
        : `type "${UNINSTALL_CONFIRM_WORD}"   esc cancel`;
    case "desktop":
    case "closing":
      return "";
    case "loading":
      return "esc cancel";
    case "failed":
    case "review":
      return "esc close";
  }
}

/** Same two-tone control the session-delete dialog uses. */
function DialogButton({
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
  const body: ReactNode = (
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
        <Text color={chromeTheme.colors.error} bold={focused}>
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
        // Focus first, act second — a click lands on the control it is
        // over, never on whatever the cursor happened to be on.
        onFocus();
        onPress();
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}
