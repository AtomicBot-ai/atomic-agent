import type { ResearchSources } from "./research-args.js";
import type { JudgeVerdict, ResearchResult, UnverifiedReason } from "./research-types.js";

const SOURCES_TEXT: Record<ResearchSources, string> = {
  web: "Sources: the web",
  documents: "Sources: your documents in My files, nothing searched online",
  both: "Sources: the web and your documents in My files",
};

const VERDICT_TEXT: Record<JudgeVerdict, string> = {
  conflict: "Judge: the sources disagree on the same figure.",
  different_measures: "Judge: they likely measure different things.",
  unclear: "Judge: the quotes do not say enough to tell.",
};

const REASON_TEXT: Record<UnverifiedReason, string> = {
  quote_not_on_page: "the quote is not on the page",
  quote_too_short: "the quote is too short to check",
  number_not_in_quote: "a number in the claim is not in the quote",
};

/** A quote as a Markdown blockquote: one line, no stray `>` breaking out. */
function blockquote(text: string): string {
  return `> ${text.replace(/\s+/g, " ").trim()}`;
}

/** `[title](url)`, the URL alone when there is no title; brackets in titles escaped. */
function link(url: string, title: string | undefined): string {
  const label = (title ?? "").replace(/[[\]]/g, "").trim();
  return label.length > 0 ? `[${label}](${url})` : `<${url}>`;
}

/**
 * The `research.deep` report as Markdown (ATO-2133): Summary, Findings
 * (each with its link and exact quote), Contradictions, Unverified
 * claims, then the sources that could not be read. Pure.
 */
export function renderResearchReport(result: ResearchResult, generatedAt: Date): string {
  const lines: string[] = [`# Research: ${result.question.replace(/\s+/g, " ").trim()}`, ""];
  lines.push(
    `_${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC. ${SOURCES_TEXT[result.sources ?? "web"]}. ` +
      `${result.pagesRead} ${result.sources === "documents" ? "passage" : "page"}(s) read, ` +
      `${result.verified.length} verified finding(s), ${result.unverified.length} unverified._`,
    "",
  );
  if (result.stoppedEarly !== undefined) lines.push(`**Stopped early:** ${result.stoppedEarly}`, "");
  lines.push("## Summary", "");
  lines.push(result.summary.trim().length > 0 ? result.summary.trim() : "No verified findings to summarise.", "");
  lines.push(
    "_The summary is written by the model from the verified findings below. Each finding's quote was found word for word on its page; the claim restating it was not judged._",
    "",
  );
  if (result.subQuestions.length > 0) {
    lines.push("Sub-questions:", "");
    result.subQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push("");
  }

  lines.push("## Findings", "");
  if (result.verified.length === 0) lines.push("None verified.", "");
  result.verified.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.claim.trim()} (${link(f.url, f.title)})`, "");
    lines.push(`   ${blockquote(f.quote)}`, "");
    if (f.derived.length > 0) lines.push(`   Computed: ${f.derived.join("; ")}`, "");
  });

  lines.push("## Contradictions", "");
  if (result.contradictions.length === 0) {
    lines.push("No conflicting numbers found between sources on the same sub-question.", "");
  }
  for (const c of result.contradictions) {
    const where = result.subQuestions[c.subQuestion] ?? `sub-question ${c.subQuestion + 1}`;
    const ruling = c.judgement === undefined
      ? "Not judged: the figures may measure different things; check both quotes."
      : `${VERDICT_TEXT[c.judgement.verdict]}${c.judgement.note.length > 0 ? ` ${c.judgement.note}` : ""}`;
    lines.push(`- ${where}: ${c.values[0]} (${link(c.a.url, c.a.title)}) vs ${c.values[1]} (${link(c.b.url, c.b.title)}). ${ruling}`);
  }
  if (result.contradictions.some((c) => c.judgement !== undefined)) {
    lines.push("", "_Each judge line is the model's reading of the two quotes. It does not say which source is right._");
  }
  if (result.contradictions.length > 0) lines.push("");

  lines.push("## Unverified claims", "");
  if (result.unverified.length === 0) lines.push("None.", "");
  for (const u of result.unverified) {
    const numbers = u.unsupportedNumbers && u.unsupportedNumbers.length > 0 ? ` (${u.unsupportedNumbers.join(", ")})` : "";
    lines.push(`- ${u.claim.trim()} (${link(u.url, u.title)}): ${REASON_TEXT[u.reason]}${numbers}.`);
    lines.push(`  ${blockquote(u.quote)}`);
  }
  if (result.unverified.length > 0) lines.push("");

  if (result.skipped.length > 0) {
    lines.push("## Sources not read", "");
    for (const s of result.skipped) lines.push(`- ${s.target}: ${s.reason}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
