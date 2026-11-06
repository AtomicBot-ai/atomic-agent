import type { TaskReportCard } from "../../tasks/index.js";

/**
 * Plain-text building blocks shared by the task report, the morning
 * digest and the live `/status` snapshot. Everything here is channel
 * infrastructure text (never `parse_mode: "HTML"`), and every cut is
 * marked so truncation is never silent.
 */

/** Appended whenever text was cut, so truncation is never silent. */
export const TASK_REPORT_TRUNCATION_MARKER = "… [truncated]";

/**
 * Size every report, digest and snapshot must stay under: one outbound
 * chunk (4000 UTF-16 units in `outbound-sender.ts`, itself under
 * Telegram's 4096), with room to spare.
 */
export const TASK_MESSAGE_MAX_CHARS = 3900;

/** Longest single line inside a section. */
export const SECTION_LINE_MAX_CHARS = 200;

/** Section line caps tried in order until the message fits. */
const SECTION_LINE_STEPS = [10, 6, 3, 1] as const;

export const SECTION_TITLES = {
  done: "Done",
  failed: "Failed",
  needsYou: "Needs you",
} as const;

/**
 * Render the card's three sections. `maxLines` caps each section; the
 * lines past it are counted, not dropped silently. An empty section
 * says "(none)" so a reader never wonders whether it was cut.
 */
export function renderSections(
  card: TaskReportCard,
  maxLines: number,
  extraFailed: readonly string[] = [],
): string {
  const parts: string[] = [];
  const cap = (lines: readonly string[]): string[] =>
    lines.map((line) => truncateWithMarker(line, SECTION_LINE_MAX_CHARS));
  // `extraFailed` arrives already capped by the caller (the task's own
  // error has its own, longer cap).
  const sections: Array<[string, readonly string[]]> = [
    [SECTION_TITLES.done, cap(card.done)],
    [SECTION_TITLES.failed, [...extraFailed, ...cap(card.failed)]],
    [SECTION_TITLES.needsYou, cap(card.needsYou)],
  ];
  for (const [title, lines] of sections) {
    parts.push(`${title}:`);
    if (lines.length === 0) {
      parts.push("  (none)");
      continue;
    }
    for (const line of lines.slice(0, maxLines)) {
      parts.push(`- ${line}`);
    }
    if (lines.length > maxLines) {
      parts.push(`  … ${lines.length - maxLines} more not shown`);
    }
  }
  return parts.join("\n");
}

/**
 * Assemble `head`, an optional free-text block and the sections inside
 * `maxChars`: sections shrink first (10, 6, 3, then 1 line each), the
 * free text takes what is left (never below `minText`), and a final
 * hard cut with the marker is the last resort.
 */
export function fitMessage(input: {
  head: string;
  text: { label: string; body: string; max: number; minText: number } | null;
  card: TaskReportCard | null;
  extraFailed?: readonly string[];
  maxChars: number;
}): string {
  const { head, text, card, maxChars } = input;
  for (const lines of SECTION_LINE_STEPS) {
    const sections = card ? renderSections(card, lines, input.extraFailed) : "";
    const fixed = joinBlocks([head, sections]).length + (text ? text.label.length + 3 : 0);
    const room = maxChars - fixed;
    const textMax = text ? Math.min(text.max, room) : 0;
    if (text && textMax < text.minText && lines !== 1) continue;
    const body = text ? `${text.label}\n${fitText(text.body, textMax)}` : "";
    const out = joinBlocks([head, body, sections]);
    if (out.length <= maxChars) return out;
  }
  const sections = card ? renderSections(card, 1, input.extraFailed) : "";
  const body = text ? `${text.label}\n${fitText(text.body, text.minText)}` : "";
  return truncateWithMarker(joinBlocks([head, body, sections]), maxChars - TASK_REPORT_TRUNCATION_MARKER.length);
}

/** `body` whole when it fits `max`, else cut so body + marker fit `max`. */
function fitText(body: string, max: number): string {
  if (body.length <= max) return body;
  return truncateWithMarker(body, Math.max(max - TASK_REPORT_TRUNCATION_MARKER.length, 0));
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((b) => b.length > 0).join("\n\n");
}

export function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${sliceByCodePoints(text, maxChars)}${TASK_REPORT_TRUNCATION_MARKER}`;
}

/** Whitespace collapsed to one line, capped with "…". */
export function oneLinePreview(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${sliceByCodePoints(flat, maxChars - 1)}…`;
}

/**
 * Take at most `limit` UTF-16 units without ever splitting a surrogate
 * pair — same code-point walk as `chunkUtf16` in
 * [outbound-sender.ts](outbound-sender.ts). A pair that straddles the
 * limit is dropped whole, so the cut can land one unit short; a naive
 * `String.prototype.slice` would instead emit a lone surrogate that
 * renders as U+FFFD in the operator's chat.
 */
export function sliceByCodePoints(text: string, limit: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > limit) break;
    out += ch;
  }
  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** `$0.42`, or `<$0.01` for a priced run that cost almost nothing. */
export function formatSpend(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
