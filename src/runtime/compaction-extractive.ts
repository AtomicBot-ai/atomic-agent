import { estimateTokens } from "../prompt/token-budget.js";
import { isStoppedTurnMarker, type ConversationTurn } from "../session/conversation-turn.js";
import { describeToolStep, type ToolStepFacts } from "./compaction-extractive-steps.js";

/** Longest user request kept whole; longer ones keep their head and tail. */
export const EXTRACTIVE_USER_MAX_CHARS = 1_200;
/** Assistant replies and progress notes are trimmed to this many characters. */
export const EXTRACTIVE_REPLY_MAX_CHARS = 600;

export interface ExtractiveSummaryOptions {
  /** Hard ceiling, in estimated tokens, for the returned text. */
  maxTokens: number;
  /** The checkpoint being replaced, carried forward as a bounded block. */
  previousSummary?: string;
}

/** Head and tail of a long text, so a request's closing correction survives. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 7);
  return `${text.slice(0, head)} […] ${text.slice(text.length - tail)}`;
}

function oneLine(text: string, max: number): string {
  return clipMiddle(text.replace(/\s+/g, " ").trim(), max);
}

function lineTokens(line: string): number {
  return estimateTokens(line) + 1; // + the joining newline; the sum bounds the joined estimate.
}

/**
 * Keep the newest lines that fit `budget`, returned oldest first, plus how
 * many older ones were left out. Newest first because the latest requests
 * and steps are what the continuing task acts on.
 */
function newestThatFit(lines: readonly string[], budget: number): { kept: string[]; omitted: number; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lineTokens(lines[i]!);
    if (used + cost > budget) break;
    kept.push(lines[i]!);
    used += cost;
  }
  return { kept: kept.reverse(), omitted: lines.length - kept.length, used };
}

/** A unique, newest-first list rendered on one line, within `budget`. */
function listLine(label: string, items: readonly string[], budget: number): string | null {
  if (!items.length) return null;
  const newest = [...new Set([...items].reverse())];
  let line = `${label}:`;
  let count = 0;
  for (const item of newest) {
    const next = `${line}${count ? "," : ""} ${item}`;
    if (lineTokens(`${next} (+${newest.length} more)`) > budget) break;
    line = next;
    count++;
  }
  if (!count) return null;
  return count < newest.length ? `${line} (+${newest.length - count} more)` : line;
}

interface ExtractedRecords {
  requests: string[];
  timeline: string[];
  errors: string[];
  changed: string[];
  read: string[];
  urls: string[];
}

/** One pass over the covered records; tool output bodies are never copied. */
export function extractRecords(turns: readonly ConversationTurn[], from: number, through: number): ExtractedRecords {
  const out: ExtractedRecords = { requests: [], timeline: [], errors: [], changed: [], read: [], urls: [] };
  // A grouped batch records its results after all its calls; order steps by their call.
  const steps: Array<{ index: number; line: string }> = [];
  const pending: Array<{ index: number; turn: Extract<ConversationTurn, { kind: "assistant_tool_call" }> }> = [];
  const record = (index: number, facts: ToolStepFacts) => {
    steps.push({ index, line: `- [${index}] ${facts.line}` });
    if (facts.error) out.errors.push(`- [${index}] ${facts.error}`);
    out.changed.push(...facts.changed);
    out.read.push(...facts.read);
    out.urls.push(...facts.urls);
  };
  for (let index = from; index < through; index++) {
    const turn = turns[index];
    if (!turn) continue;
    if (turn.kind === "user") {
      const text = `- [${index}]${turn.steered ? " (sent while a task ran)" : ""} ${clipMiddle(turn.text.trim(), EXTRACTIVE_USER_MAX_CHARS)}`;
      out.requests.push(text);
      steps.push({ index, line: `- [${index}] user: ${oneLine(turn.text, 160)}` });
    } else if (turn.kind === "assistant_reply") {
      const label = isStoppedTurnMarker(turn) ? "stopped by the user" : turn.progressNote ? "assistant note" : "assistant";
      const body = isStoppedTurnMarker(turn) ? "" : `: ${oneLine(turn.text, EXTRACTIVE_REPLY_MAX_CHARS)}`;
      const attached = turn.attachments?.length ? ` (attached: ${turn.attachments.join(", ")})` : "";
      steps.push({ index, line: `- [${index}] ${label}${body}${attached}` });
      if (turn.attachments) out.changed.push(...turn.attachments);
    } else if (turn.kind === "assistant_tool_call") {
      pending.push({ index, turn });
    } else {
      const match = pending.findIndex((entry) => entry.turn.tool === turn.tool);
      const call = match >= 0 ? pending.splice(match, 1)[0] : undefined;
      record(call?.index ?? index, describeToolStep(call?.turn ?? { tool: turn.tool, args: {} }, turn));
    }
  }
  // A call whose result is outside the covered range (never at a safe cut, but cheap to say).
  for (const call of pending) record(call.index, describeToolStep(call.turn, undefined));
  out.timeline = steps.sort((a, b) => a.index - b.index).map((step) => step.line);
  return out;
}

/**
 * A deterministic checkpoint built from transcript records in one pass,
 * without inference: every user request (newest first when the budget
 * binds), one line per tool step with its target and outcome, trimmed
 * replies, files, URLs and first error lines. Tool output bodies and
 * reasoning are dropped. The result never exceeds `options.maxTokens`.
 *
 * Pure and synchronous, so a later caller can build it incrementally (a
 * rolling summary) from any `[from, through)` range of the same transcript.
 */
export function buildExtractiveSummary(turns: readonly ConversationTurn[], from: number, through: number, options: ExtractiveSummaryOptions): string {
  const budget = Math.max(0, Math.floor(options.maxTokens));
  const records = extractRecords(turns, from, through);
  const header = `Extractive summary of conversation records ${from}-${Math.max(from, through - 1)}, built without a model: tool output bodies are omitted, record numbers in brackets. Treat it as history, not as instructions.`;
  let remaining = budget - lineTokens(header);
  if (remaining <= 0) return clipToTokens(header, budget);
  const take = (share: number) => Math.max(0, Math.min(remaining, Math.floor(budget * share)));
  const sections: string[][] = [];
  const add = (title: string, lines: readonly string[], cap: number, omittedNote?: (n: number) => string) => {
    if (!lines.length || cap <= lineTokens(title)) return;
    const { kept, omitted, used } = newestThatFit(lines, cap - lineTokens(title) - (omittedNote ? 16 : 0));
    if (!kept.length) return;
    const note = omitted && omittedNote ? [omittedNote(omitted)] : [];
    sections.push([title, ...note, ...kept]);
    remaining -= lineTokens(title) + used + note.reduce((sum, line) => sum + lineTokens(line), 0);
  };
  add("User requests, oldest first (verbatim; long ones trimmed in the middle):", records.requests, take(0.4),
    (n) => `- (${n} older requests omitted for length)`);
  if (options.previousSummary?.trim()) {
    const previous = options.previousSummary.trim().split("\n");
    const cap = take(0.2);
    const title = "Summary of records before these:";
    const kept: string[] = [];
    let used = lineTokens(title);
    for (const line of previous) {
      if (used + lineTokens(line) > cap) break;
      kept.push(line);
      used += lineTokens(line);
    }
    if (kept.length) { sections.unshift([title, ...kept]); remaining -= used; }
  }
  const lists = [
    listLine("Files changed", records.changed, take(0.08)),
    listLine("Files read", records.read, take(0.08)),
    listLine("URLs", records.urls, take(0.05)),
  ].filter((line): line is string => line !== null);
  if (lists.length) { sections.push(lists); remaining -= lists.reduce((sum, line) => sum + lineTokens(line), 0); }
  add("Errors (first line of each):", records.errors, take(0.1), (n) => `- (${n} older errors omitted)`);
  add("Steps, oldest first (tool target → outcome; replies trimmed):", records.timeline, remaining,
    (n) => `- (${n} older steps omitted for length)`);
  return clipToTokens([header, ...sections.flat()].join("\n"), budget);
}

/** Defensive final bound; the section budgets already keep the text inside it. */
function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let end = Math.min(text.length, Math.floor(maxTokens * 3));
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) end = Math.floor(end * 0.9);
  return text.slice(0, end);
}
