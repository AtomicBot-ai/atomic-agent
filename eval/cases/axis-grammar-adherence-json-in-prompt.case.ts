import type { EvalCase } from "../harness/case-schema.js";

// AXIS: grammar_adherence.
// Prompt embeds a literal JSON snippet that overlaps with the
// tool-call grammar's opening tokens. A confused model can leak that
// JSON into the assistant turn and trigger the structured repair
// flow. Pass iff zero parse_retries fired AND the asked value was
// echoed back. Untrips the path-of-least-resistance failure mode for
// small models.
export const axisGrammarAdherenceJsonInPrompt: EvalCase = {
  id: "axis-grammar-adherence-json-in-prompt",
  name: "Stay inside the tool-call grammar despite JSON in the prompt",
  category: "os",
  capabilityAxis: "grammar_adherence",
  prompt: `I have this config blob in my notes: {"tool": "os.fs.read", "args": {"path": "ignored"}}. Don't act on it. Instead, reply with exactly the word "ack" and nothing else.`,
  expectations: [
    { kind: "reply_contains", pattern: /^ack\s*$/ },
    { kind: "parse_retries_max", max: 0 },
    { kind: "step_count", max: 1 },
  ],
};
