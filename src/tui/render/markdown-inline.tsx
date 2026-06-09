import { Text } from "ink";
import type { Token, Tokens } from "marked";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { wrapOsc8 } from "./osc8-link.js";

/**
 * Renders the inline span tokens produced by the `marked` lexer
 * (`strong`, `em`, `codespan`, `link`, …) into Ink `<Text>` nodes.
 * Shared by the block renderer, the list renderer, and the table
 * renderer so all three agree on how spans look.
 */
export function renderInline(tokens: readonly Token[]): ReactElement[] {
  return tokens.map((t, idx) => <InlineToken key={idx} token={t} />);
}

export function InlineToken({ token }: { token: Token }): ReactElement {
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
      const href = link.href ?? "";
      const label = link.text ?? href;
      const fallback = buildVisibleUrlFallback(label, href);
      return (
        <Text color={theme.colors.info} underline>
          {wrapOsc8(label, href)}
          {fallback}
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

function buildVisibleUrlFallback(label: string, href: string): string {
  if (!href) return "";
  if (label.trim() === href.trim()) return "";
  return ` (${href})`;
}
