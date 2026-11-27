/**
 * ATO-2738: what a model wraps around a rewrite, taken off before the
 * answer goes back in place of the selected text ("Replace in …",
 * replace-selection.ts). Asked to rewrite a paragraph, a model often
 * answers "Sure! Here is the rewritten text:" first, or puts the text in
 * quotes or in one ``` block. Pasted as is, that lands in the person's
 * document. Raycast's "Paste to active app" and Microsoft Copilot's
 * rewrite preview put only the text itself back; this does the same.
 *
 * Careful on purpose: only a first line that ends with ":" and says it
 * is the text ("Here is the rewritten text:", "Certainly, here's the
 * translation:"), a bare "Sure!" right before such a line, one fence
 * around the whole answer, and one pair of quotes around the whole
 * answer. A rewritten email that starts "Sure! I'd be happy to help."
 * or ends "Let me know if you have questions." is the person's text and
 * stays. So does a lead-in that is the selection's own first line ("Here
 * is the updated schedule:" in the email being fixed). Pure: no Electron,
 * the node tests load it from the built output.
 */

/** "Sure!", "Certainly.", "Of course," alone on a line. */
const INTERJECTION = /^(?:sure|certainly|of course|absolutely|okay|ok|alright|got it|no problem|happy to help)[!.,]*$/i;

/** A lead-in that only announces the text: ends with ":" and names what follows. */
const LEAD_IN = new RegExp(
  "^(?:(?:sure|certainly|of course|absolutely|okay|ok|alright|great)[!.,]*\\s+)?"
  + "(?:here(?:'s|’s| is| are)|below is|the following is)\\b"
  + "[^\\n]{0,120}:$",
  "i",
);

/** The lead-in has to say it is the text: "Here is the agenda:" opens a real email and stays. */
const ABOUT_THE_TEXT = /\b(?:rewrit|re-writ|revis|improv|correct|translat|edit|polish|updat|shorter|longer|simplif|fixed|proofread|reword|rephras|version|text|paragraph|sentence|summar|draft|message|email)/i;

const isLeadIn = (line: string): boolean => LEAD_IN.test(line) && ABOUT_THE_TEXT.test(line);

/** One fence around the whole answer, with no other fence inside. */
const FENCE = /^```[\w+#.-]*[ \t]*\n([\s\S]*?)\n?```$/;

/** Quote pairs a whole answer may be wrapped in. */
const QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"], ["«", "»"], ["„", "“"],
];

function unfence(text: string): string {
  const m = FENCE.exec(text);
  if (!m || m[1].includes("```")) return text;
  return m[1].trim() || text;
}

function unquote(text: string): string {
  for (const [open, close] of QUOTES) {
    if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) continue;
    const inner = text.slice(open.length, text.length - close.length);
    // Only when the pair wraps the whole answer: no other quote of either kind inside.
    if (!inner.trim() || inner.includes(open) || inner.includes(close)) continue;
    return inner.trim();
  }
  return text;
}

/** The selection's own first line, trimmed: "" when there is none. */
function firstLine(selection: unknown): string {
  if (typeof selection !== "string") return "";
  const line = selection.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim());
  return line ? line.trim() : "";
}

function dropLeadIn(text: string, own: string): string {
  const lines = text.split("\n");
  let i = 0;
  const next = (from: number) => { let j = from; while (j < lines.length && !lines[j].trim()) j++; return j; };
  // "Sure!" on its own line counts only right before a lead-in.
  if (INTERJECTION.test(lines[0].trim())) {
    const j = next(1);
    if (j < lines.length && isLeadIn(lines[j].trim())) i = j;
  }
  if (!isLeadIn(lines[i].trim())) return text;
  // The person's own first line ("Here is the updated schedule:") stays.
  if (own && (lines[i].trim() === own || lines[0].trim() === own)) return text;
  const rest = lines.slice(i + 1).join("\n").trim();
  return rest || text;
}

export interface PreambleOptions {
  /** The selected text the answer replaces: a lead-in that is its own first line is kept. */
  selection?: string | null;
}

/**
 * The answer as it goes back in place of the selection: a lead-in line,
 * one fence around it all and one pair of quotes around it all taken off.
 * Whatever is not clearly wrapping is kept as it is; never returns "" for
 * a text that had words.
 */
export function stripModelPreamble(raw: string, opts: PreambleOptions = {}): string {
  let text = String(raw).replace(/\r\n/g, "\n").trim();
  if (!text) return text;
  text = unfence(text);
  text = dropLeadIn(text, firstLine(opts.selection));
  text = unfence(text);
  text = unquote(text);
  return text.trim();
}
