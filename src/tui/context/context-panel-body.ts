import type { ContextUsagePart } from "../../session/context-usage.js";
import { contextHint } from "./context-hint.js";
import type { ContextUsageView } from "./select-context-usage.js";

/**
 * Which rows the context panel draws, and which it sheds first when the
 * pane is short (ATO-2355; per-tool rows ATO-2453).
 */
export interface PanelRow {
  label: string;
  tokens: number;
  /** Accounting rather than content: reserved headroom and free space. */
  dim?: boolean;
  /** One part of the row above it (ATO-2355): indented, no gauge. */
  part?: boolean;
  /** One tool of the MCP server row above it (ATO-2453): indented deeper. */
  tool?: boolean;
}

/**
 * A server's tools shown before the rest fold into one "+N more" row,
 * when every tool of every server does not fit. Claude Code's `/context`
 * lists MCP tools one per line; on a short terminal the biggest few are
 * the ones worth reading.
 */
export const TOOLS_PER_SERVER_SHORT = 5;

/** The panel has something to expand: some part lists its tools. */
export function hasToolRows(usage: ContextUsageView): boolean {
  return usage.parts.some((part) => (part.tools?.length ?? 0) > 0);
}

/**
 * What fits, most useful first. With `detail`, every tool of every
 * server; then each server's biggest few. Then every row with its
 * parts and the tip; then the rows and the tip without the parts; then
 * as many rows as the pane has, as before parts existed. Detail goes
 * first, then parts, because the section rows already carry the totals
 * and the tip names the culprit.
 */
export function fitBody(
  rows: readonly PanelRow[],
  usage: ContextUsageView,
  room: number,
  detail = false,
): { visible: readonly PanelRow[]; hint: readonly string[] } {
  const hint = contextHint(usage) ?? [];
  const tries: (readonly PanelRow[])[] = [];
  if (detail && hasToolRows(usage)) {
    tries.push(withParts(rows, usage, Number.POSITIVE_INFINITY));
    tries.push(withParts(rows, usage, TOOLS_PER_SERVER_SHORT));
  }
  tries.push(withParts(rows, usage, 0), rows);
  for (const visible of tries) {
    if (visible.length + hint.length <= room) return { visible, hint };
  }
  return { visible: rows.slice(0, Math.max(0, room)), hint: [] };
}

/**
 * Each section row followed by its parts, in the order they were
 * measured, and each MCP server part by up to `toolsPerServer` of its
 * tools. Tools past the limit fold into one row so the part's tools
 * still add up to the part.
 */
export function withParts(
  rows: readonly PanelRow[],
  usage: ContextUsageView,
  toolsPerServer: number,
): readonly PanelRow[] {
  if (usage.parts.length === 0) return rows;
  const out: PanelRow[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.dim) continue;
    for (const part of usage.parts) {
      if (part.parent !== row.label) continue;
      out.push({ label: part.label, tokens: part.tokens, dim: true, part: true });
      out.push(...toolRows(part, toolsPerServer));
    }
  }
  return out;
}

function toolRows(part: ContextUsagePart, limit: number): PanelRow[] {
  const tools = part.tools ?? [];
  if (limit <= 0 || tools.length === 0) return [];
  // Folding one tool into "+1 more" saves no line.
  const shown = tools.length <= limit + 1 ? tools : tools.slice(0, limit);
  const rows: PanelRow[] = shown.map((tool) => ({
    label: tool.label,
    tokens: tool.tokens,
    dim: true,
    tool: true,
  }));
  const rest = tools.slice(shown.length);
  if (rest.length > 0) {
    rows.push({
      label: `+${rest.length} more`,
      tokens: rest.reduce((sum, tool) => sum + tool.tokens, 0),
      dim: true,
      tool: true,
    });
  }
  return rows;
}
