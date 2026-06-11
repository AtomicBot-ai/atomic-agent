/**
 * Pull a concise GAIA-style final answer from a free-form agent reply.
 * Agents are instructed to emit `FINAL ANSWER: <value>`; this helper
 * falls back to the last non-empty line when the marker is missing.
 */

// Global so we can pick the LAST occurrence — agents frequently restate
// "FINAL ANSWER" while reasoning, and the final restatement is the one
// that matters. Capture the rest of the same line (may be empty when the
// model puts the answer on the next line).
const FINAL_ANSWER_RE = /FINAL\s+ANSWER\s*:\s*(.*)$/gim;

export function extractFinalAnswer(reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed) return "";

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let lastMatch: { sameLine: string; index: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /FINAL\s+ANSWER\s*:\s*(.*)$/i.exec(lines[i] ?? "");
    if (m) lastMatch = { sameLine: (m[1] ?? "").trim(), index: i };
  }
  // Reset lastIndex defensively if the module-level regex is ever reused.
  FINAL_ANSWER_RE.lastIndex = 0;

  if (lastMatch) {
    if (lastMatch.sameLine.length > 0) {
      return stripWrappingQuotes(lastMatch.sameLine);
    }
    // Marker on its own line — take the next non-empty line as the answer.
    const next = lines[lastMatch.index + 1];
    if (next) return stripWrappingQuotes(next);
  }

  if (lines.length === 0) return "";
  return stripWrappingQuotes(lines[lines.length - 1] ?? "");
}

function stripWrappingQuotes(s: string): string {
  return s.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

export function buildGaiaUserPrompt(question: string, attachmentHint: string | null): string {
  const prefix = [
    "You are solving a GAIA benchmark question.",
    "Use tools as needed (filesystem, web, documents).",
    "When finished, your last line MUST be exactly:",
    "FINAL ANSWER: <your answer>",
    "The answer must match GAIA rules: a short string, a number, or a",
    "comma-separated list — no extra explanation on that line.",
  ].join(" ");

  const attachment = attachmentHint
    ? ` Attached file(s) are in the workspace: ${attachmentHint}.`
    : "";

  // The agent CLI reads a single line from stdin (spawnAgentRun writes
  // `${prompt}\n`), so the whole prompt MUST stay on one line — any
  // embedded newline truncates the question and the agent never sees it.
  const oneLine = `${prefix}${attachment} Question: ${collapseWhitespace(question)}`;
  return collapseWhitespace(oneLine);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
