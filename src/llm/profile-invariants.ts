import {
  GEMMA4_THINK_PROFILE,
  QWEN_THINK_PROFILE,
  type ModelProfile,
} from "./model-profile.js";

const PRELUDE_ROOT_RE = /^root ::= [a-z-]+-prelude tool-call$/m;

export function checkProfileGrammarAligned(
  profile: ModelProfile,
  grammar: string,
): string[] {
  const violations: string[] = [];

  if (profile.reasoningStyle === "none") {
    if (PRELUDE_ROOT_RE.test(grammar)) {
      violations.push("plain profile must not use a reasoning prelude root");
    }
    if (!/^root ::= tool-call$/m.test(grammar)) {
      violations.push("plain profile grammar must keep `root ::= tool-call`");
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

export function checkProfilePromptAligned(
  profile: ModelProfile,
  promptText: string,
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
