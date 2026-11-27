import type { CompressedToolResult } from "../../../compressor/result-compressor.js";
import type { ShellJobRecord } from "./shell-jobs.js";
import type { WatchedLine } from "./shell-job-watch.js";
import { renderShellResult } from "./shell-result.js";
import { formatShellDuration, formatShellElapsed } from "./shell-timeout.js";

/**
 * What `{"wait": id, "until": …}` says (ATO-2358). The matched line is
 * the point of the result, so it goes in the notice above the command
 * line, where it survives the compressor; the lines before it follow as
 * the body.
 */

/** A line shown in a notice: one line, bounded. */
function quoteLine(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > max ? `${line.slice(0, max - 1)}…` : line);
}

function droppedNote(dropped: number): string {
  return dropped > 0 ? ` (${dropped} older unread lines were dropped before they could be checked)` : "";
}

/** The job printed a matching line and is still running. */
export function renderShellLineMatched(
  record: ShellJobRecord,
  until: string,
  outcome: { line: WatchedLine; before: WatchedLine[]; dropped: number },
  notices: readonly string[] = [],
): CompressedToolResult {
  const runningMs = Date.now() - record.job.startedAt;
  const id = record.id;
  const notice =
    `job ${id} printed a line matching /${until}/: ${quoteLine(outcome.line.text)}${droppedNote(outcome.dropped)}. ` +
    `It is still running: os.shell.run {"wait": ${id}, "until": ${JSON.stringify(until)}} waits for the next match, {"kill": ${id}} stops it.`;
  const body = [...outcome.before, outcome.line].map((line) => line.text).join("\n");
  return renderShellResult({
    facts: record.facts,
    status: "ok",
    notices: [...notices, notice],
    statusLine: `matched (job ${id}, pid ${record.job.pid ?? "?"}, running ${formatShellElapsed(runningMs)}${record.keep ? ", kept" : ""})`,
    body,
    overflow: "head",
    details: {
      detached: true,
      matched: true,
      until,
      matchedLine: outcome.line.text,
      matchedStream: outcome.line.stream,
      droppedLines: outcome.dropped,
      jobId: id,
      pid: record.job.pid ?? null,
      runningMs,
      keep: record.keep,
      timedOut: false,
    },
  });
}

/** Above a still-running result: no line matched within the wait. */
export function formatUntilElapsedNotice(
  jobId: number,
  until: string,
  waitedMs: number,
  dropped: number,
): string {
  return `no line of job ${jobId} matched /${until}/ within ${formatShellDuration(waitedMs)}${droppedNote(dropped)}; os.shell.run {"wait": ${jobId}, "until": ${JSON.stringify(until)}} keeps watching, pass timeoutMs for a longer wait`;
}

/** Above an exit result: the job ended without printing a matching line. */
export function formatUntilExitedNotice(until: string, dropped: number): string {
  return `the job exited without printing a line matching /${until}/${droppedNote(dropped)}`;
}

/** Above an exit result: the matching line came, and then the job ended. */
export function formatUntilMatchedThenExitedNotice(until: string, line: string): string {
  return `the job printed a line matching /${until}/: ${quoteLine(line)}, then exited`;
}
