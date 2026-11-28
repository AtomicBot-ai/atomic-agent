import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import { summarizeUsageBreakdown, type UsageBreakdown } from "./usage-breakdown.js";
import { summarizeUsageHistory, type UsageHistorySummary } from "./usage-history-report.js";
import type { UsageHistoryFile } from "./usage-history-types.js";
import type { UsageReportOptions } from "./usage-report-args.js";
import { estimateSavedByLocal, resolveReferenceModel, type SavedByLocal } from "./usage-saved-by-local.js";

/**
 * One usage report (ATO-2442): the per-day summary, the tool and
 * project breakdown and the "saved by local" estimate, built once from
 * the history and read the same way by `atomic-agent usage`, the TUI's
 * `/usage` and `GET /api/usage` (the desktop's Usage tab).
 */
export interface UsageReport {
  summary: UsageHistorySummary;
  breakdown: UsageBreakdown;
  savedByLocal: SavedByLocal;
}

export interface UsageReportInputs {
  days: number | "all";
  today: string;
  compare?: string | null;
  /** The configured providers, for the operator's own cloud model as the reference. */
  providers?: readonly LlmProviderConfigEntry[];
  activeTextProvider?: string;
}

export function buildUsageReport(file: UsageHistoryFile, inputs: UsageReportInputs): UsageReport {
  const window = { days: inputs.days, today: inputs.today };
  const summary = summarizeUsageHistory(file, window);
  const compare = inputs.compare?.trim() || null;
  const reference = resolveReferenceModel({
    compare,
    ...(inputs.providers ? { providers: inputs.providers } : {}),
    ...(inputs.activeTextProvider !== undefined ? { activeTextProvider: inputs.activeTextProvider } : {}),
  });
  const rows = summary.days.flatMap((d) => file.days[d.day] ?? []);
  return {
    summary,
    breakdown: summarizeUsageBreakdown(file, window),
    savedByLocal: estimateSavedByLocal(rows, reference, compare),
  };
}

/**
 * The JSON view. The per-model lines only with `models`, the tool and
 * project lists only with `tools` / `projects`, like the text view;
 * `savedByLocal` always, with `estimate: true` on a figure.
 */
export function usageReportJson(
  report: UsageReport,
  options: Pick<UsageReportOptions, "models" | "tools" | "projects">,
): Record<string, unknown> {
  const summary = options.models
    ? report.summary
    : { ...report.summary, days: report.summary.days.map((d) => ({ ...d, models: undefined })) };
  return {
    ...summary,
    savedByLocal:
      report.savedByLocal.status === "estimate" ? { ...report.savedByLocal, estimate: true } : report.savedByLocal,
    ...(options.tools ? { tools: report.breakdown.tools } : {}),
    ...(options.projects ? { projects: report.breakdown.projects } : {}),
    ...(options.tools || options.projects ? { breakdownCountedFrom: report.breakdown.countedFrom } : {}),
  };
}
