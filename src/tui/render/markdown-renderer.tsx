import { Box, Text } from "ink";
import { Lexer } from "marked";
import type { Token, Tokens } from "marked";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { highlightCodeBlock } from "./syntax-highlight.js";
import { wrapOsc8 } from "./osc8-link.js";

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

function HeadingBlock({ token }: { token: Tokens.Heading }): ReactElement {
  const prefix = "#".repeat(Math.min(6, Math.max(1, token.depth)));
  return (
    <Text bold color={theme.colors.accentSoft}>
      {prefix} {renderInline(token.tokens ?? [])}
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
    <Box flexDirection="column">
      {(token.tokens ?? []).map((inner, idx) => (
        <Text key={idx} color={theme.colors.muted}>
          {"> "}
          {inner.type === "paragraph"
            ? renderInline((inner as Tokens.Paragraph).tokens ?? [])
            : (inner as { raw?: string }).raw ?? ""}
        </Text>
      ))}
    </Box>
  );
}

function ListBlock({ token }: { token: Tokens.List }): ReactElement {
  return (
    <Box flexDirection="column">
      {token.items.map((item, idx) => {
        const bullet = token.ordered
          ? `${Number(token.start ?? 1) + idx}.`
          : theme.glyphs.bullet;
        return (
          <Text key={idx}>
            <Text color={theme.colors.muted}>{bullet} </Text>
            {renderInline(item.tokens ?? [])}
          </Text>
        );
      })}
    </Box>
  );
}

function renderInline(tokens: readonly Token[]): ReactElement[] {
  return tokens.map((t, idx) => (
    <InlineToken key={idx} token={t} />
  ));
}

function InlineToken({ token }: { token: Token }): ReactElement {
  switch (token.type) {
    case "strong":
      return (
        <Text bold>{renderInline((token as Tokens.Strong).tokens ?? [])}</Text>
      );
    case "em":
      return (
        <Text italic>{renderInline((token as Tokens.Em).tokens ?? [])}</Text>
      );
    case "codespan":
      return (
        <Text color={theme.colors.info} inverse>
          {(token as Tokens.Codespan).text}
        </Text>
      );
    case "del":
      return (
        <Text strikethrough>
          {renderInline((token as Tokens.Del).tokens ?? [])}
        </Text>
      );
    case "link": {
      const link = token as Tokens.Link;
      const label = link.text ?? link.href ?? "";
      return (
        <Text color={theme.colors.info} underline>
          {wrapOsc8(label, link.href ?? "")}
        </Text>
      );
    }
    case "image": {
      const img = token as Tokens.Image;
      return (
        <Text color={theme.colors.muted}>
          [image: {img.text ?? img.href ?? ""}]
        </Text>
      );
    }
    case "br":
      return <Text>{"\n"}</Text>;
    case "text": {
      const textTok = token as Tokens.Text;
      if (textTok.tokens && textTok.tokens.length > 0) {
        return <Text>{renderInline(textTok.tokens)}</Text>;
      }
      return <Text>{textTok.text}</Text>;
    }
    default:
      return (
        <Text>
          {(token as { raw?: string; text?: string }).text ??
            (token as { raw?: string }).raw ??
            ""}
        </Text>
      );
  }
}
