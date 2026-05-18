/**
 * Memory-v2 phase 2. Builds the micro-prompt for the `link-generator`
 * reflection sub-call.
 *
 * The prompt contains:
 *   1. A short instruction explaining the task ("emit LINK lines for
 *      genuine relations between the listed notes; output NONE if
 *      nothing connects").
 *   2. The current user message + assistant reply (same payload as
 *      the main reflection prompt — gives the LLM grounding for what
 *      'relates' means in this turn).
 *   3. The candidate notes as numbered `[id] body` rows. The grammar
 *      forces the LLM to reference exactly these ids; the parser
 *      drops anything outside the allowlist anyway (anti-fabrication
 *      / anti-feedback-loop, cf. phase 7a invariant 18 in
 *      MEMORY_FABRIC_V2.md §13.7.4).
 *
 * Body previews are truncated to keep the prompt small — the
 * link-generator does not need full note bodies to spot relations,
 * the topic-level summary is enough.
 */
export interface LinkGeneratorPromptInput {
  userMessage: string;
  assistantReply: string;
  candidates: ReadonlyArray<{
    id: number;
    /** Short preview (the renderer caps to ~120 chars). */
    body: string;
  }>;
}

const PREVIEW_CHARS = 120;

export function buildLinkGeneratorPrompt(
  input: LinkGeneratorPromptInput,
): string {
  const candidateBlock = input.candidates
    .map((c) => `[${c.id}] ${trimPreview(c.body, PREVIEW_CHARS)}`)
    .join("\n");
  return [
    "Identify genuine relations between the candidate notes below.",
    "Output zero or more LINK lines, each:",
    "  LINK <from_id> <to_id> [kind=KIND]",
    "where KIND is one of:",
    "  RELATES_TO | CAUSED_BY | REFERENCES | CONTRADICTS | DUPLICATES | SUPERSEDES",
    "Use exactly the numeric ids shown in [brackets]. Do NOT invent ids.",
    "If nothing connects, output NONE.",
    "",
    "user-message:",
    truncate(input.userMessage, 600),
    "",
    "assistant-reply:",
    truncate(input.assistantReply, 600),
    "",
    "candidates:",
    candidateBlock.length > 0 ? candidateBlock : "(none)",
    "",
    "links:",
  ].join("\n");
}

function truncate(raw: string, max: number): string {
  const s = raw.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function trimPreview(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
