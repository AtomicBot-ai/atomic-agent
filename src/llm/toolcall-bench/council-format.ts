/**
 * The council as plain text for a terminal (ATO-2432): the `models
 * council` output and the TUI's `/council` notice. The verdict comes
 * first, the way Perplexity and llm-council show it: the chairman's final
 * answer, then the judge's summary, then the peer ranking, and the
 * individual answers last for whoever wants to read them.
 */

import { formatAnswers } from "./format-bench.js";
import { formatCouncilSummary } from "./model-council.js";
import type { RankStanding } from "./council-rank.js";
import type { CouncilReport } from "./run-council.js";

/** `1. or:gpt (avg 1.5 of 2 votes)` lines, best first. */
export function formatCouncilRanking(standings: readonly RankStanding[]): string {
  const lines = ["== Peer ranking (1 is best) =="];
  standings.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.model}  average place ${s.averageRank.toFixed(1)} from ${s.votes} ${s.votes === 1 ? "review" : "reviews"}`);
  });
  return `${lines.join("\n")}\n`;
}

/**
 * The whole report, verdict first. `answers: false` leaves the individual
 * answers out; `notes: false` leaves the notes to the caller (stderr).
 */
export function formatCouncilReport(
  report: CouncilReport,
  options: { answers?: boolean; notes?: boolean } = {},
): string {
  const parts: string[] = [];
  if (report.chairman?.text) parts.push(`== Final answer (chairman: ${report.chairman.model}) ==\n${report.chairman.text}\n`);
  else if (report.chairman?.error) parts.push(`== Final answer ==\nThe chairman ${report.chairman.model} failed: ${report.chairman.error}\n`);
  if (report.summary) parts.push(formatCouncilSummary(report.summary, report.judge));
  else if (report.judgeError) parts.push(`== Council summary ==\nThe judge ${report.judge} failed: ${report.judgeError}\n`);
  if (report.standings && report.standings.length > 0) parts.push(formatCouncilRanking(report.standings));
  const failedRankers = (report.rankings ?? []).filter((r) => r.error !== undefined);
  if (failedRankers.length > 0) {
    parts.push(`Rankings left out: ${failedRankers.map((r) => `${r.ranker} (${r.error})`).join(", ")}\n`);
  }
  if (options.notes !== false) for (const note of report.notes) parts.push(`Note: ${note}\n`);
  if (report.cancelled) parts.push("Stopped before the council finished.\n");
  if (options.answers !== false && report.answers.length > 0) parts.push(formatAnswers(report.answers));
  return parts.join("\n");
}
