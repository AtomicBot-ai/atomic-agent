import type { UsageBreakdown } from "./usage-breakdown.js";
import { formatTokenCount, formatUsageHistory, type UsageTotals } from "./usage-history-report.js";
import { formatUsd } from "./usage-meter.js";
import type { UsageReport } from "./usage-report.js";
import type { UsageReportOptions } from "./usage-report-args.js";
import type { SavedByLocal } from "./usage-saved-by-local.js";

/**
 * The text of a usage report (ATO-2442): the per-day table, then the
 * "saved by local" line, then the tool and project tables when asked.
 */
export function formatUsageReportText(
  report: UsageReport,
  options: Pick<UsageReportOptions, "models" | "tools" | "projects" | "sessions">,
): string {
  const parts = [formatUsageHistory(report.summary, { models: options.models, sessions: options.sessions })];
  const saved = formatSavedByLocal(report.savedByLocal);
  if (saved !== null) parts.push(saved);
  const firstDay = report.summary.days[0]?.day ?? null;
  if (options.tools) parts.push(formatToolTable(report.breakdown, firstDay));
  if (options.projects) parts.push(formatProjectTable(report.breakdown, firstDay));
  return parts.join("\n\n");
}

/** One or two lines, or `null` when no local model served anything. */
export function formatSavedByLocal(saved: SavedByLocal): string | null {
  if (saved.status === "none") return null;
  const tokens = formatTokenCount(saved.localInputTokens + saved.localOutputTokens);
  if (saved.status === "unknown") {
    return saved.requested
      ? `Saved by local: unknown. The built-in price list has no price for ${saved.requested}.`
      : `Saved by local: unknown. No cloud price to compare the ${tokens} local tokens with.`;
  }
  const r = saved.reference;
  const rates = `${formatRate(r.inputPerMTok)} in, ${formatRate(r.outputPerMTok)} out per 1M tokens`;
  const why = r.source === "configured" ? "your cloud model" : r.source === "compare" ? "the model you chose" : "a cheap cloud model";
  return [
    `Saved by local (estimate): about ${formatUsd(saved.usd)}, the ${tokens} local tokens at ${r.provider}/${r.model} list prices (${rates}; ${why}).`,
    "A rough figure: another model would not use the same tokens. Price it at another model with --compare <provider/model>.",
  ].join("\n");
}

/** `firstDay`: the oldest day the per-day table shows, to say when the split starts later. */
export function formatToolTable(breakdown: UsageBreakdown, firstDay: string | null = null): string {
  if (breakdown.tools.length === 0) {
    return "Tools\n  no tool calls recorded in this window.";
  }
  const rows = breakdown.tools.map((t) => [
    t.tool,
    String(t.calls),
    t.errors > 0 ? String(t.errors) : "-",
    `${Math.round(t.share * 100)}%`,
  ]);
  return ["Tools", ...table(["Tool", "Calls", "Errors", "Share"], rows), countedNote(breakdown, firstDay)].filter(Boolean).join("\n");
}

export function formatProjectTable(breakdown: UsageBreakdown, firstDay: string | null = null): string {
  if (breakdown.projects.length === 0) {
    return "Projects\n  nothing recorded per project in this window.";
  }
  const rows = breakdown.projects.map((p) => [
    p.label,
    String(p.calls),
    formatTokenCount(p.inputTokens),
    formatTokenCount(p.outputTokens),
    localShare(p),
    costCell(p),
  ]);
  return ["Projects", ...table(["Project", "Calls", "Input", "Output", "Local", "Cloud cost"], rows), countedNote(breakdown, firstDay)]
    .filter(Boolean)
    .join("\n");
}

function countedNote(breakdown: UsageBreakdown, firstDay: string | null): string {
  const from = breakdown.countedFrom;
  return from !== null && firstDay !== null && firstDay < from
    ? `Counted from ${from}; earlier days were recorded without this split.`
    : "";
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]): string =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function localShare(t: UsageTotals): string {
  const tokens = t.localTokens + t.cloudTokens + t.planTokens;
  return tokens > 0 ? `${Math.round((t.localTokens / tokens) * 100)}%` : "-";
}

function costCell(t: UsageTotals): string {
  if (t.pricedCalls > 0) return `${formatUsd(t.usd)}${t.unpricedCalls > 0 ? "+" : ""}`;
  if (t.unpricedCalls > 0) return "n/a";
  return "-";
}

/** `$0.15`, `$2.50`; a rate under a cent keeps its digits (`$0.003`). */
function formatRate(perMTok: number): string {
  return perMTok >= 0.01 || perMTok === 0 ? `$${perMTok.toFixed(2)}` : `$${Number(perMTok.toFixed(4))}`;
}
