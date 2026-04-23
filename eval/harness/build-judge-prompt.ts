/**
 * Prompt template for the judge. Kept tiny on purpose: we want a small
 * stable prefix so even a 7B local model can reliably produce a JSON
 * verdict. The system message is byte-stable across cases so KV-cache
 * reuse on the same llama-server slot is plausible.
 */

import type { JudgeInput } from "./judge-types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export const JUDGE_SYSTEM = [
  "You are a strict evaluator scoring an AI assistant's response.",
  "Output ONLY a single JSON object on one line, with no surrounding text and no code fence.",
  "Schema: {\"score\": <integer 1..5>, \"reason\": \"<max 200 chars>\"}",
  "Scoring guide:",
  "  1 = completely wrong, missed the task, or hallucinated.",
  "  2 = attempted but mostly wrong.",
  "  3 = partially correct; key facts present but with notable errors.",
  "  4 = correct content with minor format/clarity issues.",
  "  5 = fully correct, well-formatted, follows the rubric precisely.",
  "Be strict. If the response is empty or refuses, score 1.",
].join("\n");

export function buildJudgeMessages(input: JudgeInput): ChatMessage[] {
  const userBody = [
    "== TASK GIVEN TO ASSISTANT ==",
    input.prompt.trim(),
    "",
    "== ASSISTANT REPLY ==",
    input.reply.trim() === "" ? "(empty reply)" : input.reply.trim(),
    "",
    "== RUBRIC ==",
    input.rubric.trim(),
    "",
    "Now respond with the JSON object only.",
  ].join("\n");

  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: userBody },
  ];
}
