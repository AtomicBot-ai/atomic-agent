import { Box, Text } from "ink";
import type { Token, Tokens } from "marked";
import { Fragment, type ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { renderInline } from "./markdown-inline.js";

type CellAlign = "left" | "right" | "center" | null;

/**
 * Renders a GFM table token as an aligned Ink grid. The `marked`
 * lexer emits the header + body cells as inline-token arrays; column
 * widths are computed from each cell's **rendered** plain text (the
 * lexer's `cell.text` keeps the raw `**bold**` / `[link]()` syntax, so
 * measuring it over-counts and the columns visibly drift). Width is 1
 * per code unit — good enough for Latin/Cyrillic, CJK is a known
 * approximation.
 */
export function TableBlock({ token }: { token: Tokens.Table }): ReactElement {
  const header = token.header;
  const rows = token.rows;
  const align = (token.align ?? []) as CellAlign[];
  const widths = computeColumnWidths(header, rows);
  return (
    <Box flexDirection="column">
      <TableRow cells={header} widths={widths} align={align} bold />
      <Text color={theme.colors.muted}>{separatorLine(widths)}</Text>
      {rows.map((row, idx) => (
        <TableRow key={idx} cells={row} widths={widths} align={align} />
      ))}
    </Box>
  );
}

interface TableRowProps {
  cells: readonly Tokens.TableCell[];
  widths: readonly number[];
  align: readonly CellAlign[];
  bold?: boolean;
}

function TableRow({ cells, widths, align, bold }: TableRowProps): ReactElement {
  return (
    <Text>
      {cells.map((cell, c) => {
        const width = widths[c] ?? 0;
        const [leftPad, rightPad] = padFor(
          cellWidth(cell),
          width,
          align[c] ?? "left",
        );
        return (
          <Fragment key={c}>
            {c > 0 ? <Text color={theme.colors.muted}> │ </Text> : null}
            <Text>{leftPad}</Text>
            <Text bold={bold}>{renderInline(cell.tokens ?? [])}</Text>
            <Text>{rightPad}</Text>
          </Fragment>
        );
      })}
    </Text>
  );
}

function computeColumnWidths(
  header: readonly Tokens.TableCell[],
  rows: readonly Tokens.TableCell[][],
): number[] {
  const widths = header.map((cell) => cellWidth(cell));
  for (const row of rows) {
    row.forEach((cell, c) => {
      widths[c] = Math.max(widths[c] ?? 0, cellWidth(cell));
    });
  }
  return widths;
}

function cellWidth(cell: Tokens.TableCell | undefined): number {
  if (!cell) return 0;
  const inline = cell.tokens ?? [];
  if (inline.length === 0) return (cell.text ?? "").length;
  return plainTextWidth(inline);
}

/**
 * Visible width of inline tokens once the markdown markers are
 * stripped — recurses into nested spans (`strong`, `em`, `link`, …)
 * and falls back to the leaf `text` / `raw` for atoms (`codespan`).
 */
function plainTextWidth(tokens: readonly Token[]): number {
  let width = 0;
  for (const token of tokens) {
    const inner = (token as { tokens?: Token[] }).tokens;
    if (inner && inner.length > 0) {
      width += plainTextWidth(inner);
      continue;
    }
    const leaf =
      (token as { text?: string }).text ??
      (token as { raw?: string }).raw ??
      "";
    width += leaf.length;
  }
  return width;
}

function padFor(
  contentWidth: number,
  columnWidth: number,
  align: CellAlign,
): [string, string] {
  const total = Math.max(0, columnWidth - contentWidth);
  if (align === "right") return [" ".repeat(total), ""];
  if (align === "center") {
    const left = Math.floor(total / 2);
    return [" ".repeat(left), " ".repeat(total - left)];
  }
  return ["", " ".repeat(total)];
}

function separatorLine(widths: readonly number[]): string {
  return widths.map((w) => "─".repeat(w)).join("─┼─");
}
