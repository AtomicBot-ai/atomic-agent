/**
 * Model council (ATO-2232): several models answer one question, then one
 * judge model compares the answers and lists what they agree on, where
 * they disagree, and what only one of them said. The answers reach the
 * judge under letters (A, B, ...) instead of model names, as in Karpathy's
 * llm-council, so the judge rates the content and not the name; the
 * letters are mapped back to model names after parsing.
 *
 * Pure: building the judge prompt, parsing its reply, printing the result.
 * The requests themselves live in the `models council` command.
 */

import type { ModelAnswer } from "./ask-many-models.js";

/** An answer longer than this reaches the judge cut, so the prompt stays bounded. */
export const COUNCIL_MAX_ANSWER_CHARS = 12_000;

/** One answered model and the letter the judge sees it under. */
export interface CouncilMember {
  label: string;
  model: string;
  text: string;
}

export interface CouncilSummary {
  agree: string[];
  disagree: string[];
  /** Points only one answer made, keyed by model name; every member has a key. */
  unique: Record<string, string[]>;
  /** False when no section heading was found; print `raw` then. */
  parsed: boolean;
  raw: string;
}

/** Letter for the n-th member: A..Z, then M27, M28, ... */
export function councilLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `M${index + 1}`;
}

/** The answers worth judging (no error, not empty), lettered in the named order. */
export function councilMembers(answers: readonly ModelAnswer[]): CouncilMember[] {
  return answers
    .filter((a) => a.error === undefined && (a.text ?? "").trim() !== "")
    .map((a, i) => ({ label: councilLabel(i), model: a.model, text: (a.text ?? "").trim() }));
}

/** `text` cut at `max` characters with a note, so a prompt that quotes answers stays bounded. */
export function boundedAnswer(text: string, max: number = COUNCIL_MAX_ANSWER_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[answer cut at ${max} characters]`;
}

/**
 * The prompt the judge model gets. Model names never appear in it.
 * `maxAnswerChars` lowers the per-answer cut when the whole prompt must
 * fit a smaller request (the runtime's plain route, ATO-2432).
 */
export function buildCouncilPrompt(
  question: string,
  members: readonly CouncilMember[],
  maxAnswerChars: number = COUNCIL_MAX_ANSWER_CHARS,
): string {
  const answers = members.map((m) => `### Answer ${m.label}\n${boundedAnswer(m.text, maxAnswerChars)}`).join("\n\n");
  const uniqueTemplate = members.map((m) => `### Answer ${m.label}\n- a point only answer ${m.label} makes`).join("\n");
  return [
    "You are the judge of a model council. Several models answered the same question on their own.",
    "Their answers are labeled by letter; the names are hidden on purpose so you judge the content.",
    "",
    "## Question",
    question.trim(),
    "",
    "## Answers",
    answers,
    "",
    "Compare the answers. Reply in exactly this format, short bullet points, nothing before or after:",
    "",
    "## Agree",
    "- a point every answer makes",
    "## Disagree",
    "- a point where the answers conflict, naming the letters (A says X, B says Y)",
    "## Unique",
    uniqueTemplate,
    "",
    'Write "- none" under a heading that has nothing to list.',
  ].join("\n");
}

type Section = "agree" | "disagree" | "unique";

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const EMPTY_ITEM = /^(?:none|nothing|n\/a|-)\.?$/i;

/** `## Agree`, `**Agree**`, `Agree:` and the like, without the markup. */
function headingText(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("#")) return t.replace(/^#+\s*/, "").replace(/[*:]+$/g, "").replace(/^\*+/, "").trim();
  const bold = /^\*\*(.+?)\*\*:?$/.exec(t);
  if (bold) return bold[1]!.replace(/:$/, "").trim();
  const colon = /^([A-Za-z][A-Za-z ]{0,30}):$/.exec(t);
  return colon ? colon[1]!.trim() : null;
}

function sectionOf(heading: string): Section | null {
  const h = heading.toLowerCase();
  if (/^(?:points? of )?(?:disagree|disagreement|conflict)/.test(h)) return "disagree";
  if (/^(?:points? of )?(?:agree|agreement|consensus)/.test(h)) return "agree";
  if (/^unique/.test(h)) return "unique";
  return null;
}

/** The member a label names: `Answer A`, `A`, `Response B (x)`, or the model name itself. */
function memberOf(text: string, members: readonly CouncilMember[]): CouncilMember | undefined {
  const t = text.trim().replace(/^\*+|\*+$/g, "").trim();
  // The whole label must be the letter, so a point like "A key idea: x" is not read as answer A.
  const letter = /^(?:answer|response|model)?\s*([A-Z]|M\d+)(?:\s*\(.*\))?$/i.exec(t);
  if (letter) {
    const found = members.find((m) => m.label.toLowerCase() === letter[1]!.toLowerCase());
    if (found) return found;
  }
  return members.find((m) => m.model.toLowerCase() === t.toLowerCase());
}

/** `A: point` or `or:gpt-4o: point` inside the Unique section, split into member and point. */
function prefixedPoint(item: string, members: readonly CouncilMember[]): { member: CouncilMember; point: string } | null {
  const lower = item.toLowerCase();
  const byName = [...members]
    .sort((a, b) => b.model.length - a.model.length)
    .find((m) => lower.startsWith(`${m.model.toLowerCase()}:`));
  if (byName) return { member: byName, point: item.slice(byName.model.length + 1).trim() };
  const at = item.indexOf(":");
  if (at <= 0 || at > 24) return null;
  const member = memberOf(item.slice(0, at), members);
  return member ? { member, point: item.slice(at + 1).trim() } : null;
}

/**
 * Read the judge's reply into the three sections. Lenient: any heading
 * level, bold headings, `Agree:` lines, numbered or dashed bullets, and in
 * Unique either one sub-heading per answer or `A: point` bullets. Points
 * reading "none" are dropped. A reply with no recognised heading comes
 * back with `parsed: false` and the text in `raw`.
 */
export function parseCouncilSummary(reply: string, members: readonly CouncilMember[]): CouncilSummary {
  const summary: CouncilSummary = { agree: [], disagree: [], unique: {}, parsed: false, raw: reply.trim() };
  for (const m of members) summary.unique[m.model] = [];
  let section: Section | null = null;
  let current: CouncilMember | undefined;
  const add = (point: string) => {
    const p = point.trim();
    if (p === "" || EMPTY_ITEM.test(p) || section === null) return;
    if (section !== "unique") {
      summary[section].push(p);
      return;
    }
    const prefixed = prefixedPoint(p, members);
    if (prefixed) {
      if (prefixed.point !== "" && !EMPTY_ITEM.test(prefixed.point)) summary.unique[prefixed.member.model]!.push(prefixed.point);
      return;
    }
    if (current) summary.unique[current.model]!.push(p);
  };
  for (const line of reply.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const heading = headingText(line);
    if (heading !== null) {
      const next = sectionOf(heading);
      if (next) {
        section = next;
        current = undefined;
        summary.parsed = true;
        continue;
      }
      if (section === "unique") {
        const member = memberOf(heading, members);
        if (member) {
          current = member;
          continue;
        }
      }
    }
    const bullet = BULLET.exec(line);
    add(bullet ? bullet[1]! : line);
  }
  return summary;
}

function list(points: readonly string[], indent: string): string[] {
  return points.length === 0 ? [`${indent}(nothing)`] : points.map((p) => `${indent}- ${p}`);
}

/** The judge's summary as plain text, under the model names. */
export function formatCouncilSummary(summary: CouncilSummary, judge: string): string {
  const title = `== Council summary (judge: ${judge}) ==`;
  if (!summary.parsed) return `${title}\n${summary.raw || "(empty summary)"}\n`;
  const lines = [title, "Agree", ...list(summary.agree, "  "), "Disagree", ...list(summary.disagree, "  "), "Unique"];
  for (const [model, points] of Object.entries(summary.unique)) lines.push(`  ${model}`, ...list(points, "    "));
  return `${lines.join("\n")}\n`;
}
