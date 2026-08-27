import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import {
  projectTokensForPairs,
  type ContextUsageView,
} from "../select-context-usage.js";
import { readableOn } from "../theme/readable-foreground.js";
import { chromeTheme } from "../theme/theme.js";
import { fitToWidth } from "./fit-to-width.js";
import { formatTokens } from "./format-tokens.js";
import { renderProgressBar } from "./render-progress-bar.js";

/** Panel width, clamped to the pane on narrow terminals. */
const PREFERRED_WIDTH = 58;
/** Border (2) + title + hairline + footer. */
const CHROME_ROWS = 5;
/** Columns held for the section name, so the numbers form a column. */
const LABEL_WIDTH = 20;
/** Columns held for the token count. */
const TOKENS_WIDTH = 8;
/** Columns held for the share. */
const PERCENT_WIDTH = 5;
/** Cells of mini-gauge on each row. */
const ROW_GAUGE = 10;

export interface ContextPanelProps {
  /**
   * `null` before the first prompt of the session has been built. The
   * panel still renders: it is reachable from the menu and from
   * `/context`, and a surface that takes the keyboard and then paints
   * nothing is worse than one that says it has nothing yet.
   */
  usage: ContextUsageView | null;
  /**
   * Task count the operator is pricing, if any. `null` renders what the
   * last prompt actually did.
   */
  pairsDraft?: number | null;
  /** Rows available in the pane the panel floats over. */
  availableRows: number;
  /** Columns available in that pane. */
  availableColumns: number;
  /**
   * Tokens the runtime holds back for the model's own reply. Rendered as
   * its own line under the rule: it is not in the prompt, but it is the
   * reason the prompt cannot grow into the last of the window.
   */
  reservedForReply: number | null;
  /**
   * Switches `agent.conversationMaxTokens` to auto. Absent hides the
   * button — the panel is also rendered by tests and by surfaces with
   * no way to write config, and a button that did nothing when pressed
   * would be worse than no button.
   */
  onSetAuto?: () => void;
}

/**
 * Where the context window went, opened by clicking the composer's
 * context chip (or `/context`).
 *
 * The chip answers "how full"; this answers "with what", which is the
 * question an operator actually acts on — a session that is 80% full of
 * conversation wants `/clear`, one that is 80% full of loaded tools and
 * recalled memory wants a different fix entirely, and no other surface
 * in the app distinguishes them.
 *
 * Rendered as a true overlay, the same way `MenuPopup` is: absolutely
 * positioned inside the content pane so nothing below it reflows, and
 * every interior line padded to the panel's exact inner width, because a
 * terminal has no z-index and occlusion has to be painted.
 */
export function ContextPanel({
  usage,
  availableRows,
  availableColumns,
  reservedForReply,
  onSetAuto,
  pairsDraft = null,
}: ContextPanelProps): ReactElement {
  const width = Math.max(32, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  const inner = width - 2;
  if (usage === null) {
    return (
      <PanelFrame
        offsetTop={Math.max(0, Math.floor((availableRows - 7) / 2))}         offsetLeft={Math.max(0, Math.floor((availableColumns - width) / 2))}
        width={width}
      >
        <Text color={chromeTheme.colors.railForeground} bold>
          {fitToWidth(" context · not measured yet", inner)}
        </Text>
        <Text color={chromeTheme.colors.railMuted}>
          {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
        </Text>
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(" send a message — the breakdown comes from the", inner)}
        </Text>
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(" prompt the agent actually builds", inner)}
        </Text>
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(" esc to close", inner)}
        </Text>
      </PanelFrame>
    );
  }
  const rows = buildRows(usage, reservedForReply);
  // Row gauges are scaled to the biggest section, not to the window.
  // Against the window every bar but one rounds to nothing — the
  // transcript is 24% and the rest are noise — and a chart where every
  // bar is empty is a worse answer than no chart. The percentage column
  // still carries the absolute share.
  const largest = Math.max(1, ...usage.sections.map((s) => s.tokens));
  const bodyRows = Math.max(1, Math.min(rows.length, availableRows - CHROME_ROWS));
  const visible = rows.slice(0, bodyRows);
  const height = visible.length + CHROME_ROWS;
  const offsetTop = Math.max(0, Math.floor((availableRows - height) / 2));
  const offsetLeft = Math.max(0, Math.floor((availableColumns - width) / 2));
  return (
    <PanelFrame offsetTop={offsetTop} offsetLeft={offsetLeft} width={width}>
      <Text color={chromeTheme.colors.railForeground} bold>
        {fitToWidth(` ${title(usage)}`, inner)}
      </Text>
      <Text color={chromeTheme.colors.railMuted}>
        {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
      </Text>
      {visible.map((row) => (
        <Text
          key={row.label}
          color={
            row.dim ? chromeTheme.colors.railMuted : chromeTheme.colors.railForeground
          }
        >
          {fitToWidth(renderRow(row, usage, largest), inner)}
        </Text>
      ))}
      {usage.conversationCap === null ? null : (
        <Text color={chromeTheme.colors.railMuted}>
          {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
        </Text>
      )}
      {transcriptLine(usage) === null ? null : (
        <Text color={chromeTheme.colors.railForeground}>
          {fitToWidth(transcriptLine(usage) as string, inner)}
        </Text>
      )}
      {/*
        The dial's answer. Only while a number is being tried — an
        unchanging "at 20 tasks" line under the real one would be the
        same measurement twice.
      */}
      {pairsDraft === null || usage.pairsCap <= 0 ? null : (
        <Text color={chromeTheme.colors.railAccent} bold>
          {projectionLine(usage, pairsDraft, inner)}
        </Text>
      )}
      {/*
        One line, at the bottom, and never a second column.

        It used to be a `capped by` label in the left column with its
        value in the right, plus — when the ceiling was the thing
        holding the transcript down — a third line underneath spelling
        out the fix. Three lines and two columns to say one sentence,
        in a panel whose every other row is a *measurement*. This is not
        a measurement; it is the note explaining them, so it reads as a
        sentence and sits under the rule with the rest of the prose.
      */}
      <CapNote usage={usage} inner={inner} onSetAuto={onSetAuto} />
      <Text color={chromeTheme.colors.railMuted}>{fitToWidth(` ${footer(usage)}`, inner)}</Text>
    </PanelFrame>
  );
}

interface PanelRow {
  label: string;
  tokens: number;
  /** Accounting rather than content: reserved headroom and free space. */
  dim?: boolean;
}

/**
 * The prompt's sections, then the two lines that account for the rest of
 * the window. Free space is what is left after the prompt and the
 * reply's reservation — it can go negative on an over-count, and is
 * floored at zero rather than shown as a negative, which would read as a
 * bug rather than as a full window.
 */
function buildRows(
  usage: ContextUsageView,
  reservedForReply: number | null,
): readonly PanelRow[] {
  const rows: PanelRow[] = usage.sections.map((section) => ({
    label: section.label,
    tokens: section.tokens,
  }));
  if (usage.contextWindow === null) return rows;
  if (reservedForReply !== null && reservedForReply > 0) {
    rows.push({ label: "reserved for reply", tokens: reservedForReply, dim: true });
  }
  const free =
    usage.contextWindow - usage.tokens - (reservedForReply ?? 0);
  rows.push({ label: "free", tokens: Math.max(0, free), dim: true });
  return rows;
}

function renderRow(
  row: PanelRow,
  usage: ContextUsageView,
  largest: number,
): string {
  const label = ` ${row.label}`.padEnd(LABEL_WIDTH);
  const tokens = formatTokens(row.tokens).padStart(TOKENS_WIDTH);
  if (usage.contextWindow === null) return `${label}${tokens}`;
  const share = (row.tokens / usage.contextWindow) * 100;
  // A section that rounds to nothing still cost something. `0%` claims
  // it was free.
  const rounded = Math.round(share);
  const percent = (rounded === 0 && row.tokens > 0 ? "<1%" : `${rounded}%`).padStart(
    PERCENT_WIDTH,
  );
  // Accounting rows get their share but no gauge: a bar for "free" would
  // compete with the bars above it for the same eye, and it is the one
  // quantity the reader can infer from the others.
  if (row.dim) return `${label}${tokens}${percent}`;
  const relative = (row.tokens / largest) * 100;
  return `${label}${tokens}${percent} ${renderProgressBar(relative, ROW_GAUGE)}`;
}

function title(usage: ContextUsageView): string {
  if (usage.contextWindow === null) {
    return `context · ${formatTokens(usage.tokens)} · window unknown`;
  }
  return `context · ${formatTokens(usage.tokens)} of ${formatTokens(
    usage.contextWindow,
  )} window · ${usage.percent}%`;
}

/**
 * Where the transcript stands against the point at which older turns
 * start being dropped. One measurement, in the same two columns as
 * every other row above it.
 *
 * What is *holding* it there moved out of this function and into
 * {@link CapNote}: it was never a measurement, and rendering it as one
 * cost three lines and two columns to say a single sentence.
 */
function transcriptLine(usage: ContextUsageView): string | null {
  const cap = usage.conversationCap;
  if (cap === null) return null;
  const head = ` transcript`.padEnd(LABEL_WIDTH);
  // Tasks first when there is a task limit: it is the unit the operator
  // set, so it is the unit the answer should come back in. The token
  // figure stays because it is what the window actually charges.
  const tokens = `${formatTokens(usage.conversationTokens)} of ${formatTokens(cap)}`;
  // With a task limit in force the fraction of tasks *is* the answer to
  // "how much before older go", so the trailing phrase is redundant —
  // and both together do not fit the panel's width. Without one, the
  // sentence is still the only thing that says what the number means.
  return usage.pairsCap > 0
    ? `${head}${usage.pairs} of ${usage.pairsCap} tasks · ${tokens}`
    : `${head}${tokens} before older turns go`;
}

/**
 * What the prompt would cost carrying `draft` tasks — the line that
 * makes the dial worth having.
 *
 * Drawn against the model's window, because that is the number the
 * operator is actually managing: the point of holding history down is to
 * leave the model room to think, and a bar that filled against the task
 * limit would read 100% while the window sat half empty.
 */
function projectionLine(
  usage: ContextUsageView,
  draft: number,
  inner: number,
): string {
  const projected = projectTokensForPairs(usage, draft);
  const head = ` at ${draft} task${draft === 1 ? "" : "s"}`.padEnd(LABEL_WIDTH);
  if (usage.contextWindow === null) {
    return fitToWidth(`${head}${formatTokens(projected)} · window unknown`, inner);
  }
  const percent = Math.min(
    100,
    Math.round((projected / usage.contextWindow) * 100),
  );
  const bar = renderProgressBar(percent, ROW_GAUGE);
  return fitToWidth(
    `${head}[${bar}] ${formatTokens(projected)}/${formatTokens(
      usage.contextWindow,
    )} · ${percent}%`,
    inner,
  );
}

/**
 * The one-line note under the rule: what is holding the transcript down,
 * and — where it is the operator's own ceiling and the window has room
 * to spare — a button that lifts it.
 *
 * The button is the actionable half made actionable. Naming
 * `agent.conversationMaxTokens` told an operator which knob to go and
 * find; this turns the same sentence into the thing that turns it. It
 * appears only when it would do something: the ceiling must be what
 * binds, and the window must actually be bigger than it.
 */
function CapNote({
  usage,
  inner,
  onSetAuto,
}: {
  usage: ContextUsageView;
  inner: number;
  onSetAuto?: () => void;
}): ReactElement | null {
  const cap = usage.conversationCap;
  if (cap === null) return null;
  const window = usage.contextWindow;
  const canLift =
    usage.capSource === "config" && window !== null && cap < window;
  if (canLift && onSetAuto) {
    // The sentence first, then the button — so the button is the last
    // thing on the line and reads as what to do about what was just
    // said, rather than as a word wedged into the middle of it.
    // `fitToWidth` pads the head rather than trimming the button: the
    // button's width is fixed, and it is the part that must survive.
    const head = ` your ${formatTokens(cap)} cap holds this under ${formatTokens(
      window,
    )} · `;
    return (
      <Box>
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(head, Math.max(0, inner - AUTO_LABEL.length))}
        </Text>
        <SetAutoButton onPress={onSetAuto} />
      </Box>
    );
  }
  return (
    <Text color={chromeTheme.colors.railMuted}>
      {fitToWidth(` ${capSentence(usage)}`, inner)}
    </Text>
  );
}

/**
 * Padded so the ground reads as a button rather than as coloured text,
 * and carrying its own key: the panel has one control and one hint to
 * give, and putting the hint on the control is cheaper than a footer
 * line that has to be kept in sync with whether the button is showing.
 */
const AUTO_LABEL = " set auto (a) ";

function SetAutoButton({ onPress }: { onPress: () => void }): ReactElement {
  const face = (
    <Text
      backgroundColor={chromeTheme.colors.accent}
      color={readableOn(chromeTheme.colors.accent)}
      bold
    >
      {AUTO_LABEL}
    </Text>
  );
  const mouse = useMouseCommands();
  // No mouse provider: still draw the face. `a` works from the keyboard
  // either way, and a button that vanished without a mouse would hide
  // the only hint that the key exists.
  if (!mouse) return face;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onPress();
        return true;
      }}
    >
      {face}
    </MouseTarget>
  );
}

/** The note when there is nothing to press — one sentence, no columns. */
function capSentence(usage: ContextUsageView): string {
  const window =
    usage.contextWindow === null ? null : formatTokens(usage.contextWindow);
  switch (usage.capSource) {
    case "auto":
      return window === null
        ? "capped by the window — auto, no ceiling set"
        : `capped by the ${window} window — auto, no ceiling set`;
    case "window":
      return window === null
        ? "capped by the model's window"
        : `capped by the model's ${window} window`;
    case "floor":
      return "window too small for this prompt";
    case "pairs":
      return `holding the last ${usage.pairsCap} task${
        usage.pairsCap === 1 ? "" : "s"
      } — press - / + to try another`;
    case "config":
      return "capped by your agent.conversationMaxTokens setting";
    default:
      return "";
  }
}

/**
 * The footer explains the chip's violet, which is the state's only other
 * signal. Without it "why did it change colour" has no answer anywhere
 * in the app.
 */
function footer(usage: ContextUsageView): string {
  if (usage.droppedPairs > 0) {
    return `${usage.droppedPairs} earlier task${
      usage.droppedPairs === 1 ? "" : "s"
    } trimmed · enter to apply · esc to close`;
  }
  if (usage.droppedTurns > 0) {
    return `${usage.droppedTurns} older turn${
      usage.droppedTurns === 1 ? "" : "s"
    } trimmed · esc to close`;
  }
  return "esc to close";
}

/**
 * The panel's own box. Claims presses so a click on the border or the
 * footer cannot fall through to the backdrop and close the thing the
 * operator just opened.
 */
function PanelFrame({
  offsetTop,
  offsetLeft,
  width,
  children,
}: {
  offsetTop: number;
  offsetLeft: number;
  width: number;
  children: React.ReactNode;
}): ReactElement {
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => (mouse ? isPrimaryPress(hit.event) : false),
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
      {children}
    </Box>
  );
}
