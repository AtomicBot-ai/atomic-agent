import { Box, Text } from "ink";
import { Lexer } from "marked";
import type { Token, Tokens } from "marked";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { renderInline } from "./markdown-inline.js";
import { TableBlock } from "./markdown-table.js";
import { highlightCodeBlock } from "./syntax-highlight.js";

interface MarkdownRendererProps {
  text: string;
}

/**
 * Renders a markdown-ish string using Ink primitives. Uses the `marked`
 * lexer (no HTML pipeline) and walks tokens into `<Text>` / `<Box>`
 * trees. Unknown token types degrade to raw text so the renderer is
 * always safe to call on partially-formatted model output.
 */
export function MarkdownRenderer({ text }: MarkdownRendererProps): ReactElement {
  const tokens = safeLex(text);
  if (tokens === null) return <Text>{text}</Text>;
  return (
    <Box flexDirection="column">
      {tokens.map((token, idx) => renderBlockToken(token, idx))}
    </Box>
  );
}

function safeLex(text: string): Token[] | null {
  try {
    return Lexer.lex(text);
  } catch {
    return null;
  }
}

function renderBlockToken(token: Token, key: number): ReactElement | null {
  switch (token.type) {
    case "heading":
      return <HeadingBlock key={key} token={token as Tokens.Heading} />;
    case "paragraph":
      return <ParagraphBlock key={key} token={token as Tokens.Paragraph} />;
    case "code":
      return <CodeBlock key={key} token={token as Tokens.Code} />;
    case "table":
      return <TableBlock key={key} token={token as Tokens.Table} />;
    case "list":
      return <ListBlock key={key} token={token as Tokens.List} />;
    case "blockquote":
      return <BlockquoteBlock key={key} token={token as Tokens.Blockquote} />;
    case "hr":
      return (
        <Text key={key} color={theme.colors.muted}>
          ────────
        </Text>
      );
    case "space":
      return <Text key={key}> </Text>;
    case "html":
    case "text":
    case "def":
      return (
        <Text key={key}>
          {(token as { text?: string; raw?: string }).text ??
            (token as { raw?: string }).raw ??
            ""}
        </Text>
      );
    default:
      return (
        <Text key={key}>{(token as { raw?: string }).raw ?? ""}</Text>
      );
  }
}

/**
 * Headings render as bold accent text — no literal `#` markers and no
 * underline (underline under Cyrillic + spaces renders ragged on most
 * terminals). The `marked` lexer already emits a `space` token for the
 * blank line before a heading, so no extra top margin is added here to
 * avoid stacking two blank rows.
 */
function HeadingBlock({ token }: { token: Tokens.Heading }): ReactElement {
  return (
    <Text bold color={theme.colors.accentSoft}>
      {renderInline(token.tokens ?? [])}
    </Text>
  );
}

function ParagraphBlock({ token }: { token: Tokens.Paragraph }): ReactElement {
  return <Text>{renderInline(token.tokens ?? [])}</Text>;
}

function CodeBlock({ token }: { token: Tokens.Code }): ReactElement {
  const language = token.lang ?? "";
  const highlighted = highlightCodeBlock(token.text, language);
  const lines = highlighted.split("\n");
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      <Text color={theme.colors.muted}>
        ``` {language}
      </Text>
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
      <Text color={theme.colors.muted}>```</Text>
    </Box>
  );
}

function BlockquoteBlock({ token }: { token: Tokens.Blockquote }): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft
      borderColor={theme.colors.muted}
      paddingLeft={1}
    >
      {(token.tokens ?? []).map((inner, idx) => renderBlockToken(inner, idx))}
    </Box>
  );
}

function ListBlock({
  token,
  depth = 0,
}: {
  token: Tokens.List;
  depth?: number;
}): ReactElement {
  const start = Number(token.start ?? 1);
  return (
    <Box flexDirection="column">
      {token.items.map((item, idx) => (
        <ListItem
          key={idx}
          item={item}
          ordered={token.ordered}
          marker={token.ordered ? `${start + idx}.` : theme.glyphs.bullet}
          depth={depth}
        />
      ))}
    </Box>
  );
}

function ListItem({
  item,
  marker,
  depth,
}: {
  item: Tokens.ListItem;
  ordered: boolean;
  marker: string;
  depth: number;
}): ReactElement {
  const tokens = item.tokens ?? [];
  const nestedLists = tokens.filter(
    (t): t is Tokens.List => t.type === "list",
  );
  const inlineTokens = tokens.filter((t) => t.type !== "list");
  const indent = "  ".repeat(depth);
  return (
    <Box flexDirection="column">
      <Text>
        {indent}
        <Text color={theme.colors.muted}>{marker} </Text>
        {renderListItemInline(inlineTokens)}
      </Text>
      {nestedLists.map((nested, idx) => (
        <ListBlock key={idx} token={nested} depth={depth + 1} />
      ))}
    </Box>
  );
}

/**
 * List item bodies arrive as `text` (tight lists) or `paragraph`
 * (loose lists) tokens wrapping the actual inline spans. Unwrap one
 * level so bold/links/code inside a bullet render instead of dumping
 * the wrapper's raw text.
 */
function renderListItemInline(tokens: readonly Token[]): ReactElement[] {
  const inline: Token[] = [];
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "text") {
      const inner = (token as { tokens?: Token[] }).tokens;
      if (inner && inner.length > 0) {
        inline.push(...inner);
        continue;
      }
    }
    inline.push(token);
  }
  return renderInline(inline);
}
