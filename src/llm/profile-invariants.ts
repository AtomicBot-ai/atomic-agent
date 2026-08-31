import {
  GEMMA4_THINK_PROFILE,
  QWEN_THINK_PROFILE,
  getReasoningTurnFraming,
  type ModelProfile,
} from "./model-profile.js";

// After parallel-tool-calls landed and the GBNF first-token bias
// problem was identified, the root collapsed to array-only on both
// reasoning and plain profiles. A "solo" step is now `[{...}]`.
const PRELUDE_ROOT_RE = /^root ::= [a-z-]+-prelude tool-call-array$/m;
const PLAIN_ROOT_RE = /^root ::= tool-call-array$/m;

export function checkProfileGrammarAligned(
  profile: ModelProfile,
  grammar: string,
): string[] {
  const violations: string[] = [];

  if (profile.reasoningStyle === "none") {
    if (PRELUDE_ROOT_RE.test(grammar)) {
      violations.push("plain profile must not use a reasoning prelude root");
    }
    if (!PLAIN_ROOT_RE.test(grammar)) {
      violations.push(
        "plain profile grammar must keep `root ::= tool-call-array`",
      );
    }
    return violations;
  }

  if (!PRELUDE_ROOT_RE.test(grammar)) {
    violations.push("reasoning profile grammar must route root through a prelude rule");
  }
  if (!grammar.includes(escapeGrammarLiteral(profile.reasoningCloseTag))) {
    violations.push("reasoning profile grammar must contain the configured close tag");
  }
  return violations;
}

export interface PromptAlignmentOptions {
  /**
   * Whether the prompt was built with the reasoning prefill / turn
   * framing at the generation point. `false` on the native-tools chat
   * transport, where `buildPrompt` suppresses the prefill (a literal
   * `<think>` shipped to an OpenAI-compatible endpoint is at best noise
   * and at worst corrupted server-side — ollama/ollama#17248, issue
   * #283) and the invariant flips: the prompt must NOT end with a
   * reasoning prelude. Defaults to `true` (grammar-transport legacy).
   */
  promptCarriesPrefill?: boolean;
}

export function checkProfilePromptAligned(
  profile: ModelProfile,
  promptText: string,
  options: PromptAlignmentOptions = {},
): string[] {
  const violations: string[] = [];
  const trimmed = promptText.trimEnd();

  if (profile.reasoningStyle === "none") {
    const leakedPrefix = getKnownReasoningOpenTags().find((tag) => trimmed.endsWith(tag));
    if (leakedPrefix) {
      violations.push("plain profile prompt must not end with a reasoning prelude");
    }
    return violations;
  }

  if (options.promptCarriesPrefill === false) {
    const leakedPrefix = getKnownReasoningOpenTags().find((tag) => trimmed.endsWith(tag));
    if (leakedPrefix) {
      violations.push(
        "prefill-suppressed prompt must not end with a reasoning prelude",
      );
    }
    // Turn-framed profiles (Gemma 4) leak differently: their template
    // artifact at the generation point is the model-turn opener, not a
    // reasoning open tag. A suppressed prompt must carry neither.
    const leakedFraming = getKnownTurnFramingTails().find((tail) =>
      trimmed.endsWith(tail),
    );
    if (leakedFraming) {
      violations.push(
        "prefill-suppressed prompt must not end with a model-turn opener",
      );
    }
    return violations;
  }

  const framing = getReasoningTurnFraming(profile);
  if (framing) {
    // Turn-framed profiles (Gemma 4) end at the model-turn opener; the model
    // emits its own reasoning open tag, so the prompt must NOT end with it.
    if (!trimmed.endsWith(framing.assistantOpen.trimEnd())) {
      violations.push(
        "turn-framed reasoning profile prompt must end with the model-turn opener",
      );
    }
    return violations;
  }

  if (!trimmed.endsWith(profile.reasoningOpenTag.trimEnd())) {
    violations.push("reasoning profile prompt must end with the configured open tag");
  }
  return violations;
}

function escapeGrammarLiteral(text: string): string {
  return text.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function getKnownReasoningOpenTags(): string[] {
  return [
    QWEN_THINK_PROFILE.reasoningOpenTag.trimEnd(),
    GEMMA4_THINK_PROFILE.reasoningOpenTag.trimEnd(),
  ];
}

function getKnownTurnFramingTails(): string[] {
  const framing = getReasoningTurnFraming(GEMMA4_THINK_PROFILE);
  return framing ? [framing.assistantOpen.trimEnd()] : [];
}
