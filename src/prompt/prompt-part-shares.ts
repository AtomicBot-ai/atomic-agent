import { estimateTokens } from "./token-budget.js";

/**
 * Turning measured pieces of prompt text into token rows that add up
 * (ATO-2355, ATO-2453).
 *
 * The context panel shows a section's total and then what it is made of.
 * Estimating every piece on its own rounds up once per piece, so the raw
 * figures sum to a little more than the section; these helpers scale
 * them so the rows always add up to the row they break down.
 */
export interface PromptPart {
  label: string;
  tokens: number;
  /** Set when the part is one MCP server's tool entries. */
  mcpServer?: string;
  /**
   * One row per tool of that server, largest first, summing to `tokens`
   * (ATO-2453: `/context detail` and the desktop's expanded server row).
   * Absent on parts that are not an MCP server's.
   */
  tools?: readonly PromptToolCost[];
}

export interface PromptToolCost {
  /** The tool's own name, without the `mcp.<server>.` prefix. */
  label: string;
  tokens: number;
}

/** The row for every tool entry that is not an MCP server's. */
export const BUILTIN_TOOLS_PART = "built-in tools";

/** One piece of measured text, before it is priced. */
export interface MeasuredPart {
  label: string;
  text: string;
  mcpServer?: string;
  /** The server's tools, each with its own text. */
  tools?: readonly { label: string; text: string }[];
}

/**
 * Share `total` across `weights` in proportion, by largest remainder so
 * the integers add up to `total` exactly. Ties go to the earlier slot.
 * All zeros when there is nothing to share or nothing to share it by.
 */
export function shareOut(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, rest: value - shares[index]! }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let k = 0; k < left; k += 1) {
    const slot = byRemainder[k % byRemainder.length]!.index;
    shares[slot] = shares[slot]! + 1;
  }
  return shares;
}

/**
 * Price the parts so they sum to `total`, then price each server's tools
 * so they sum to that server's part. Parts that round to nothing are
 * dropped: a zero row says less than no row.
 */
export function apportionParts(
  measured: readonly MeasuredPart[],
  total: number,
): PromptPart[] {
  const shares = shareOut(measured.map((m) => estimateTokens(m.text)), total);
  const parts: PromptPart[] = [];
  measured.forEach((m, index) => {
    const tokens = shares[index]!;
    if (tokens <= 0) return;
    const tools = m.tools !== undefined ? priceTools(m.tools, tokens) : [];
    parts.push({
      label: m.label,
      tokens,
      ...(m.mcpServer !== undefined ? { mcpServer: m.mcpServer } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    });
  });
  return parts;
}

/** Largest first, so the expanded row leads with the tool worth removing. */
function priceTools(
  tools: readonly { label: string; text: string }[],
  total: number,
): PromptToolCost[] {
  const shares = shareOut(tools.map((t) => estimateTokens(t.text)), total);
  return tools
    .map((t, index) => ({ label: t.label, tokens: shares[index]! }))
    .filter((t) => t.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}
