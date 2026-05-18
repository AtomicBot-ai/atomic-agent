import {
  LESSON_ACTIVATION_MAX_LENGTH,
  LESSON_PRINCIPLE_MAX_LENGTH,
  LESSON_MAX_TAGS,
  LESSON_TAG_MAX_LENGTH,
} from "../lessons/lesson-store.js";

/**
 * Memory-v2 phase 5. Parsed output of the distill LLM call. Either
 * a real lesson, or a sentinel `kind: "none"` indicating the model
 * abstained ("(no consensus)" / "(no durable advice)").
 *
 * The runner converts the abstention into a `skipped` outcome
 * without writing to `LessonStore`. We never store an abstention as
 * a lesson — the cluster will get another shot on the next tick.
 */
export type ParsedDistill =
  | {
      kind: "lesson";
      activation: string;
      principle: string;
      tags: string[];
    }
  | { kind: "none" };

export class DistillParseError extends Error {
  constructor(
    public readonly reason:
      | "no_lesson_line"
      | "missing_activation"
      | "missing_principle"
      | "oversized_activation"
      | "oversized_principle"
      | "malformed_quotes",
    message: string,
  ) {
    super(message);
    this.name = "DistillParseError";
  }
}

const ACTIVATION_RE = /activation=\"([^\"]+)\"/;
const PRINCIPLE_RE = /principle=\"([^\"]+)\"/;
const TAGS_RE = /tags=([^"\n;]+)/;
const TAG_TOKEN_RE = /^[a-z][a-z0-9_\-]{0,39}$/;
const NONE_ACTIVATION = "(no consensus)";
const NONE_PRINCIPLE = "(no durable advice)";

/**
 * Parse a single `LESSON ...` line out of `raw`. Forgiving by
 * design — the grammar enforces shape, but the LLM occasionally
 * adds a trailing whitespace artefact or a stray comment line; we
 * pick the first `LESSON ...` line we can find and ignore the rest.
 *
 * Empty / blank input throws `DistillParseError`. Validation errors
 * (oversize fields, missing required parts) also throw — the runner
 * folds these into a single `agent.memory.consolidation.run{outcome=failed}`
 * counter and skips the cluster.
 */
export function parseDistillOutput(raw: string): ParsedDistill {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    throw new DistillParseError("no_lesson_line", "empty distill output");
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("LESSON"));
  if (!line) {
    throw new DistillParseError(
      "no_lesson_line",
      "no LESSON line in distill output",
    );
  }
  const activationMatch = ACTIVATION_RE.exec(line);
  const principleMatch = PRINCIPLE_RE.exec(line);
  if (!activationMatch) {
    throw new DistillParseError(
      "missing_activation",
      "LESSON line missing activation",
    );
  }
  if (!principleMatch) {
    throw new DistillParseError(
      "missing_principle",
      "LESSON line missing principle",
    );
  }
  const activation = activationMatch[1]!.trim();
  const principle = principleMatch[1]!.trim();
  if (activation === NONE_ACTIVATION && principle === NONE_PRINCIPLE) {
    return { kind: "none" };
  }
  if (activation.length === 0) {
    throw new DistillParseError(
      "missing_activation",
      "activation must be non-empty",
    );
  }
  if (principle.length === 0) {
    throw new DistillParseError(
      "missing_principle",
      "principle must be non-empty",
    );
  }
  if (activation.length > LESSON_ACTIVATION_MAX_LENGTH) {
    throw new DistillParseError(
      "oversized_activation",
      `activation exceeds ${LESSON_ACTIVATION_MAX_LENGTH} chars`,
    );
  }
  if (principle.length > LESSON_PRINCIPLE_MAX_LENGTH) {
    throw new DistillParseError(
      "oversized_principle",
      `principle exceeds ${LESSON_PRINCIPLE_MAX_LENGTH} chars`,
    );
  }
  const tagsMatch = TAGS_RE.exec(line);
  const tags = tagsMatch ? parseTags(tagsMatch[1]!) : [];
  return { kind: "lesson", activation, principle, tags };
}

function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > LESSON_TAG_MAX_LENGTH) continue;
    if (!TAG_TOKEN_RE.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= LESSON_MAX_TAGS) break;
  }
  return out;
}
