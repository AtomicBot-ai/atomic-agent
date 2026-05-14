import { Text } from "ink";
import {
  createElement,
  Fragment,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  formatToolArgsBlock,
  previewToolArgs,
} from "./tool-args-preview.js";
import { wrapText } from "./wrap-text.js";
import { theme } from "../theme/theme.js";
import type {
  ChatMessage,
  StreamingToolCall,
  ToolCardEntry,
  TuiState,
} from "../tui-state.js";

/**
 * Builds a flat array of single-row `<Text>` elements that represent
 * the entire chat history at the current width. Each element is
 * exactly one terminal row (no internal `\n`, no implicit Ink wrap),
 * which lets `chat-log.tsx` slice the buffer into a viewport-sized
 * window for line-precise scrolling — exactly the behaviour we want
 * from a "scrolls like a web page" UX.
 *
 * The builder is pure and deterministic: same `state` + `ctx` always
 * produces the same `Line[]`. No refs, no measurement, no state hooks.
 *
 * Output ordering mirrors the previous `<ChatLog>` component tree:
 *   - finalised messages, oldest first
 *   - streaming tail (reasoning → tool cards → in-flight tool calls
 *     → assistant reply preview)
 *   - thinking indicator (when the turn is in flight)
 */
const RIBBON_GLYPH = "│";
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply"]);
const SUMMARY_LIMIT = 180;
const PREVIEW_SUMMARY_LIMIT = 160;

export interface ChatLineCtx {
  /** Effective inner width available to a chat row, in columns. */
  columns: number;
  /** Per-tool-card expand bit, indexed by `toolCardId`. */
  toolsExpanded: Readonly<Record<string, boolean>>;
}

interface BuilderState {
  lines: ReactElement[];
  next: number;
}

export function buildChatLines(
  state: TuiState,
  ctx: ChatLineCtx,
): ReactElement[] {
  const builder: BuilderState = { lines: [], next: 0 };
  for (const message of state.messages) {
    appendMessage(builder, message, ctx);
  }
  appendStreamingTail(builder, state, ctx);
  return builder.lines;
}

function appendMessage(
  b: BuilderState,
  message: ChatMessage,
  ctx: ChatLineCtx,
): void {
  if (message.role === "user") {
    appendBubble(b, message.text, theme.colors.user, ctx, { markdown: false });
    return;
  }
  if (message.role === "assistant") {
    if (message.reasoningBlocks && message.reasoningBlocks.length > 0) {
      appendReasoningBubble(b, message.reasoningBlocks, false, ctx);
    }
    if (message.toolCards) {
      for (const card of message.toolCards) {
        if (HIDDEN_TOOL_NAMES.has(card.tool)) continue;
        appendToolCard(b, card, ctx.toolsExpanded[card.id] ?? false, ctx);
      }
    }
    appendBubble(b, message.text, theme.colors.assistant, ctx, {
      markdown: true,
    });
    if ((message.toolSteps ?? 0) > 0) {
      appendAssistantFooter(b, message.toolSteps ?? 0);
    }
    return;
  }
  appendSystemBubble(b, message.text, ctx);
}

function appendStreamingTail(
  b: BuilderState,
  state: TuiState,
  ctx: ChatLineCtx,
): void {
  const hasStream =
    state.streamingAssistantText !== null ||
    state.streamingToolCalls.length > 0 ||
    state.streamingToolCards.length > 0 ||
    state.reasoning.length > 0;
  if (!hasStream) return;
  const reasoningTexts = state.reasoning.map((r) => r.text);
  const reasoningExpanded =
    state.streamingAssistantText === null ||
    state.streamingAssistantText.length === 0;
  if (reasoningTexts.length > 0) {
    appendReasoningBubble(b, reasoningTexts, reasoningExpanded, ctx);
  }
  for (const card of state.streamingToolCards) {
    if (HIDDEN_TOOL_NAMES.has(card.tool)) continue;
    appendToolCard(b, card, ctx.toolsExpanded[card.id] ?? false, ctx);
  }
  for (const call of state.streamingToolCalls) {
    if (HIDDEN_TOOL_NAMES.has(call.tool)) continue;
    appendToolCard(b, call, ctx.toolsExpanded[call.id] ?? false, ctx);
  }
  if (state.streamingAssistantText !== null) {
    appendBubble(
      b,
      state.streamingAssistantText,
      theme.colors.assistant,
      ctx,
      { markdown: false },
    );
  }
}

interface BubbleOptions {
  /** Strip simple markdown markers (`**bold**`, `*italic*`, `` `code` ``) before wrap. */
  markdown: boolean;
}

function appendBubble(
  b: BuilderState,
  rawText: string,
  color: string,
  ctx: ChatLineCtx,
  opts: BubbleOptions,
): void {
  const text = opts.markdown ? stripMarkdownMarkers(rawText) : rawText;
  const innerWidth = Math.max(10, ctx.columns - 4);
  const wrapped = wrapText(text, innerWidth);
  // marginTop=1 — empty separator row above the bubble.
  pushBlank(b);
  // paddingTop — ribbon-only row (border with no body content).
  pushRibbon(b, color);
  // Body rows.
  if (wrapped.length === 0 || (wrapped.length === 1 && wrapped[0] === "")) {
    pushRibbonBody(b, color, "");
  } else {
    for (const row of wrapped) pushRibbonBody(b, color, row);
  }
  // paddingBottom — ribbon-only row.
  pushRibbon(b, color);
}

function appendReasoningBubble(
  b: BuilderState,
  blocks: readonly string[],
  expanded: boolean,
  ctx: ChatLineCtx,
): void {
  if (blocks.length === 0) return;
  const joined = blocks.join("\n\n").trim();
  if (joined.length === 0) return;
  const innerWidth = Math.max(10, ctx.columns - 4);
  const body = expanded
    ? joined
    : clip(joined.replace(/\s+/g, " "), SUMMARY_LIMIT);
  const wrapped = wrapText(body, innerWidth);
  const color = theme.colors.reasoning;
  pushBlank(b);
  pushRibbon(b, color);
  // Header line: "◈ reasoning (N blocks)".
  const headerKey = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key: headerKey },
      createElement(Text, { color }, `${RIBBON_GLYPH} `),
      createElement(
        Text,
        { color, bold: true },
        `${theme.glyphs.reasoningMarker} reasoning`,
      ),
      createElement(
        Text,
        { color: theme.colors.muted },
        ` (${blocks.length} block${blocks.length === 1 ? "" : "s"})`,
      ),
    ),
  );
  for (const row of wrapped) {
    pushRibbonBodyMuted(b, color, row);
  }
  pushRibbon(b, color);
}

function appendSystemBubble(
  b: BuilderState,
  text: string,
  ctx: ChatLineCtx,
): void {
  const color = theme.colors.system;
  const innerWidth = Math.max(10, ctx.columns - 4);
  const wrapped = wrapText(text, innerWidth);
  pushBlank(b);
  for (const row of wrapped) {
    const key = `cl-${b.next++}`;
    b.lines.push(
      createElement(
        Text,
        { key },
        createElement(Text, { color }, `  ${theme.glyphs.systemMarker} `),
        createElement(Text, { color }, row),
      ),
    );
  }
}

function appendAssistantFooter(b: BuilderState, toolSteps: number): void {
  const key = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key },
      createElement(Text, { color: theme.colors.assistant }, "   ●"),
      createElement(
        Text,
        { color: theme.colors.muted },
        ` ${toolSteps} tool step${toolSteps === 1 ? "" : "s"}`,
      ),
    ),
  );
}

function appendToolCard(
  b: BuilderState,
  card: ToolCardEntry | StreamingToolCall,
  expanded: boolean,
  ctx: ChatLineCtx,
): void {
  const isFinalised = "status" in card;
  const status: "pending" | "ok" | "error" = isFinalised
    ? card.status
    : "pending";
  const color = toolColor(status);
  const glyph = toolGlyph(status);
  const argsPreview = previewToolArgs(card.args);
  const duration =
    isFinalised && card.finishedAt
      ? `${card.finishedAt - card.startedAt}ms`
      : "…";
  const truncated = isFinalised && card.truncated;

  const headerKey = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key: headerKey },
      createElement(
        Text,
        { color },
        `  ${theme.glyphs.toolBoxTopLeft}${theme.glyphs.toolBoxHorizontal} ${glyph} ${card.tool}`,
      ),
      createElement(
        Text,
        { color: theme.colors.muted },
        ` ${theme.glyphs.dotSeparator} ${duration}`,
      ),
      truncated
        ? createElement(
            Text,
            { color: theme.colors.warn },
            ` ${theme.glyphs.dotSeparator} truncated`,
          )
        : null,
      argsPreview
        ? createElement(
            Text,
            { color: theme.colors.muted },
            `  ${argsPreview}`,
          )
        : null,
    ),
  );

  if (!expanded) {
    if (isFinalised) {
      const summary = clipOneLine(card.summary, PREVIEW_SUMMARY_LIMIT);
      if (summary !== "") {
        const sumKey = `cl-${b.next++}`;
        b.lines.push(
          createElement(
            Text,
            { key: sumKey, color },
            `  ${theme.glyphs.toolBoxBottomLeft}${theme.glyphs.toolBoxHorizontal} ${summary}`,
          ),
        );
      }
    }
    pushBlank(b);
    return;
  }

  // Expanded: args + result.
  const innerWidth = Math.max(10, ctx.columns - 4);
  pushPlain(b, "    args", theme.colors.muted);
  for (const row of wrapText(formatToolArgsBlock(card.args), innerWidth)) {
    pushPlain(b, `    ${row}`);
  }
  if (isFinalised) {
    pushPlain(b, "    result", theme.colors.muted);
    for (const row of wrapText(card.summary, innerWidth)) {
      pushPlain(b, `    ${row}`, color);
    }
  } else {
    pushPlain(b, "    (pending)", theme.colors.muted);
  }
  pushBlank(b);
}

function pushBlank(b: BuilderState): void {
  const key = `cl-${b.next++}`;
  b.lines.push(createElement(Text, { key }, " "));
}

function pushRibbon(b: BuilderState, color: string): void {
  const key = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key },
      createElement(Text, { color }, RIBBON_GLYPH),
    ),
  );
}

function pushRibbonBody(b: BuilderState, color: string, body: string): void {
  const key = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key },
      createElement(Text, { color }, `${RIBBON_GLYPH}  `),
      createElement(Text, null, body),
    ),
  );
}

function pushRibbonBodyMuted(
  b: BuilderState,
  color: string,
  body: string,
): void {
  const key = `cl-${b.next++}`;
  b.lines.push(
    createElement(
      Text,
      { key },
      createElement(Text, { color }, `${RIBBON_GLYPH}  `),
      createElement(Text, { color: theme.colors.muted }, body),
    ),
  );
}

function pushPlain(b: BuilderState, body: string, color?: string): void {
  const key = `cl-${b.next++}`;
  const node: ReactNode = color
    ? createElement(Text, { color }, body)
    : body;
  b.lines.push(createElement(Text, { key }, node ?? createElement(Fragment)));
}

function toolColor(status: "pending" | "ok" | "error"): string {
  switch (status) {
    case "ok":
      return theme.colors.toolOk;
    case "error":
      return theme.colors.toolError;
    default:
      return theme.colors.tool;
  }
}

function toolGlyph(status: "pending" | "ok" | "error"): string {
  switch (status) {
    case "ok":
      return theme.glyphs.check;
    case "error":
      return theme.glyphs.cross;
    default:
      return theme.glyphs.chevronRight;
  }
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function clipOneLine(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 1)}…`;
}

/**
 * Strips the three markdown markers we render literally elsewhere
 * (`**bold**`, `*italic*`, `` `code` ``) so the assistant's reply
 * does not display the raw asterisks / backticks. Inline bold styling
 * is intentionally **not** preserved — keeping the string flat is the
 * load-bearing contract that lets `wrapText` count physical columns
 * without reasoning about markup. Multi-line fences (```` ``` ````)
 * are not stripped: they would be more confusing without the fence
 * marker on a row of plain bodies.
 */
function stripMarkdownMarkers(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1");
}
