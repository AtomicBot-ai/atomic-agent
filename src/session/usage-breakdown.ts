import { daysInWindow, totalsOf, type UsageTotals, type UsageWindow } from "./usage-history-report.js";
import { USAGE_NO_PROJECT_KEY, type UsageHistoryFile, type UsageProjectRow } from "./usage-history-types.js";

/**
 * The tool and project views of `usage-history.json` (ATO-2442), over
 * the same window as the per-day table. Precedent: OpenCode `stats`
 * (tool usage, `--project`), `ccusage` per-project reports.
 *
 * Days recorded before these sections existed simply have none: a
 * window that reaches back that far shows only what was counted since.
 */
export interface UsageProjectLine extends UsageTotals {
  /** Short hash of the folder's path; `-` for calls outside any chat. */
  project: string;
  /** The folder's name; two folders with the same name get the hash's start appended. */
  label: string;
}

export interface UsageToolLine {
  tool: string;
  calls: number;
  errors: number;
  /** Share of all tool calls in the window, 0 to 1. */
  share: number;
}

export interface UsageBreakdown {
  projects: UsageProjectLine[];
  tools: UsageToolLine[];
  /** The first day in the window that has a project or tool record, `null` for none. */
  countedFrom: string | null;
}

export function summarizeUsageBreakdown(file: UsageHistoryFile, window: UsageWindow): UsageBreakdown {
  const projectDays = daysInWindow(Object.keys(file.projects ?? {}), window);
  const toolDays = daysInWindow(Object.keys(file.tools ?? {}), window);
  const first = [projectDays[0], toolDays[0]].filter((d): d is string => d !== undefined).sort()[0];
  return {
    projects: projectLines(projectDays.flatMap((d) => file.projects?.[d] ?? [])),
    tools: toolLines(toolDays.map((d) => file.tools?.[d] ?? {})),
    countedFrom: first ?? null,
  };
}

function projectLines(rows: readonly UsageProjectRow[]): UsageProjectLine[] {
  const byKey = new Map<string, { label: string; rows: UsageProjectRow[] }>();
  for (const r of rows) {
    const entry = byKey.get(r.project) ?? { label: r.label, rows: [] };
    // Rows are oldest first: the newest name of a folder wins.
    entry.label = r.label;
    entry.rows.push(r);
    byKey.set(r.project, entry);
  }
  const labelCount = new Map<string, number>();
  for (const { label } of byKey.values()) labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
  const lines = [...byKey.entries()].map(([project, { label, rows: own }]): UsageProjectLine => ({
    project,
    label: (labelCount.get(label) ?? 0) > 1 && project !== USAGE_NO_PROJECT_KEY ? `${label} (${project.slice(0, 4)})` : label,
    ...totalsOf(own),
  }));
  // Biggest first; calls outside any chat last whatever their size.
  return lines.sort((a, b) => {
    if ((a.project === USAGE_NO_PROJECT_KEY) !== (b.project === USAGE_NO_PROJECT_KEY)) {
      return a.project === USAGE_NO_PROJECT_KEY ? 1 : -1;
    }
    return tokensOf(b) - tokensOf(a);
  });
}

function toolLines(days: readonly Record<string, { calls: number; errors: number }>[]): UsageToolLine[] {
  const sums = new Map<string, { calls: number; errors: number }>();
  for (const day of days) {
    for (const [tool, count] of Object.entries(day)) {
      const s = sums.get(tool) ?? { calls: 0, errors: 0 };
      s.calls += count.calls;
      s.errors += count.errors;
      sums.set(tool, s);
    }
  }
  const all = [...sums.values()].reduce((n, s) => n + s.calls, 0);
  return [...sums.entries()]
    .map(([tool, s]) => ({ tool, calls: s.calls, errors: s.errors, share: all > 0 ? s.calls / all : 0 }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function tokensOf(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens;
}
