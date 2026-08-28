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
  usageAtPairs,
  type ContextUsageView,
} from "../select-context-usage.js";
import { readableOn } from "../theme/readable-foreground.js";
import { chromeTheme } from "../theme/theme.js";
import { fitToWidth } from "./fit-to-width.js";
import { formatTokens } from "./format-tokens.js";
import { renderProgressBar } from "./render-progress-bar.js";

/** Panel width, clamped to the pane on narrow terminals. */
const PREFERRED_WIDTH = 58;
/**
 * Border (2) + title + hairline + hairline + selector + footer.
 *
 * Was 5, from a time when everything under the second rule was
 * conditional and the count quietly ignored it. The selector is always
 * drawn, so an undercount here would make the panel two rows taller than
 * the space it was given and push its own footer off a short terminal.
 */
const CHROME_ROWS = 7;
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
   * Task count currently selected. `null` means the selector has not
   * been touched this visit and the panel shows what the last prompt
   * actually measured.
   */
  pairsDraft?: number | null;
  /** Step the selector by `delta`, clamped to 1..100 by the reducer. */
  onStepPairs?: (delta: number) => void;
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
  usage: measured,
  availableRows,
  availableColumns,
  reservedForReply,
  pairsDraft = null,
  onStepPairs,
}: ContextPanelProps): ReactElement {
  const width = Math.max(32, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  const inner = width - 2;
  if (measured === null) {
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
  // Every figure below is read off one view, so they cannot disagree.
  // Only project once the operator has actually moved the selector:
  // until then the panel should show what was measured, not an estimate
  // of the same thing that rounds a few tokens differently.
  const selected = pairsDraft ?? measured.pairsCap;
  const usage =
    pairsDraft === null || pairsDraft === measured.pairsCap
      ? measured
      : usageAtPairs(measured, pairsDraft);
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
      <Text color={chromeTheme.colors.railMuted}>
        {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
      </Text>
      {/*
        The one control, where three lines of prose used to be.

        Those lines named `agent.conversationMaxTokens` and offered to
        set it to auto — a token ceiling, described in tokens, for a
        limit nobody reasons about in tokens. The selector says the same
        thing in the unit the operator thinks in, and every number above
        it recalculates as they work it, so the consequence of the
        choice is on screen while the choice is being made rather than
        one turn later.
      */}
      <TaskSelector
        selected={selected}
        inner={inner}
        {...(onStepPairs ? { onStep: onStepPairs } : {})}
      />
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
 * How many tasks the next prompt will carry, and the two buttons that
 * change it.
 *
 * A selector rather than a sentence. What stood here named a token
 * ceiling and offered to lift it, which asked the operator to reason in
 * a unit they do not think in about a limit they cannot picture. This
 * is the number they set, in the unit they set it in, with the cost of
 * every value visible above it as they move.
 */
function TaskSelector({
  selected,
  inner,
  onStep,
}: {
  selected: number;
  inner: number;
  onStep?: (delta: number) => void;
}): ReactElement {
  const label = " tasks per turn".padEnd(LABEL_WIDTH);
  const value = String(selected).padStart(3);
  return (
    <Box>
      <Text color={chromeTheme.colors.railForeground}>{label}</Text>
      <StepButton
        glyph=" − "
        // At the floor the button is drawn but inert: removing it would
        // shift the value and the other button sideways at exactly the
        // moment the operator is aiming at them.
        disabled={selected <= PAIRS_MIN}
        {...(onStep ? { onPress: () => onStep(-1) } : {})}
      />
      <Text color={chromeTheme.colors.railForeground} bold>
        {` ${value} `}
      </Text>
      <StepButton
        glyph=" + "
        disabled={selected >= PAIRS_MAX}
        {...(onStep ? { onPress: () => onStep(1) } : {})}
      />
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(
          `  sent each turn (${PAIRS_MIN}-${PAIRS_MAX})`,
          Math.max(0, inner - LABEL_WIDTH - 11),
        )}
      </Text>
    </Box>
  );
}

/** The bounds the schema enforces, mirrored so the UI cannot offer more. */
const PAIRS_MIN = 1;
const PAIRS_MAX = 100;

function StepButton({
  glyph,
  disabled,
  onPress,
}: {
  glyph: string;
  disabled: boolean;
  onPress?: () => void;
}): ReactElement {
  const ground = disabled
    ? chromeTheme.colors.badgeBackground
    : chromeTheme.colors.accent;
  const face = (
    <Text
      backgroundColor={ground}
      color={disabled ? chromeTheme.colors.railMuted : readableOn(ground)}
      bold={!disabled}
    >
      {glyph}
    </Text>
  );
  const mouse = useMouseCommands();
  // No mouse provider: still draw the face. `-` and `+` work from the
  // keyboard either way, and a control that vanished without a mouse
  // would take the only hint that the keys exist with it.
  if (!mouse || disabled || !onPress) return face;
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

/**
 * The footer explains the chip's violet, which is the state's only other
 * signal. Without it "why did it change colour" has no answer anywhere
 * in the app.
 */
function footer(usage: ContextUsageView): string {
  const keys = "- / + to change · esc to close";
  if (usage.droppedPairs > 0) {
    return `${usage.droppedPairs} earlier task${
      usage.droppedPairs === 1 ? "" : "s"
    } dropped · ${keys}`;
  }
  return keys;
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
