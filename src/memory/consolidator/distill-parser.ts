import {
  LESSON_ACTIVATION_MAX_LENGTH,
  LESSON_PRINCIPLE_MAX_LENGTH,
  LESSON_MAX_TAGS,
  LESSON_TAG_MAX_LENGTH,
} from "../lessons/lesson-store.js";
import {
  PROCEDURE_ACTIVATION_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_TOOL_HINT_MAX_LENGTH,
  PROCEDURE_MIN_STEPS,
  PROCEDURE_MAX_STEPS,
  PROCEDURE_MAX_TAGS,
  type ProcedureStep,
} from "../procedures/procedure-store.js";

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

/**
 * Memory-v2 phase 7b. Parsed output of the combined
 * lesson+procedure distill LLM call. The lesson half mirrors
 * `ParsedDistill`. The procedure half is `null` when the model
 * chose to skip it (scenario 7b.B). The runner always invokes
 * `parseDistillWithProcedureOutput` — the consolidator then either
 * persists `{ lesson + procedure }` or `{ lesson + null }`
 * depending on the shape.
 */
export type ParsedDistillWithProcedure =
  | {
      kind: "lesson";
      activation: string;
      principle: string;
      tags: string[];
      procedure: ParsedProcedure | null;
    }
  | { kind: "none" };

export interface ParsedProcedure {
  activation: string;
  steps: ProcedureStep[];
  tags: string[];
}

const PROC_ACTIVATION_RE = /activation=\"([^\"]+)\"/;
const PROC_STEPS_RE = /steps=\"([^\"]+)\"/;
const PROC_TAGS_RE = /tags=([^"\n;]+)/;
const TOOL_HINT_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

export class ProcedureDistillParseError extends Error {
  constructor(
    public readonly reason:
      | "missing_activation"
      | "missing_steps"
      | "oversized_activation"
      | "too_few_steps"
      | "too_many_steps"
      | "oversized_step"
      | "oversized_tool_hint"
      | "malformed_tool_hint",
    message: string,
  ) {
    super(message);
    this.name = "ProcedureDistillParseError";
  }
}

/**
 * Parse the combined `LESSON ... [PROCEDURE ...]` output. The
 * lesson half is identical to `parseDistillOutput` so existing
 * tests stay green when only a `LESSON` line is present (scenario
 * 7b.B). The procedure half is optional and only invoked if a
 * `PROCEDURE` line is found.
 *
 * Steps inside the `PROCEDURE` line are encoded as a single quoted
 * string with `;` separators and an optional `@toolhint` suffix
 * per step. The parser splits, trims, validates, and folds the
 * result into a `ParsedProcedure`. Malformed step shapes raise
 * `ProcedureDistillParseError`; the runner folds these failures
 * into the procedure-half `null` path so the lesson still gets
 * persisted (failure isolation — scenario 7b.B.1).
 */
export function parseDistillWithProcedureOutput(
  raw: string,
): ParsedDistillWithProcedure {
  const base = parseDistillOutput(raw);
  if (base.kind === "none") return base;
  const text = (raw ?? "").trim();
  const procLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("PROCEDURE"));
  if (!procLine) {
    return { ...base, procedure: null };
  }
  try {
    const procedure = parseProcedureLine(procLine);
    return { ...base, procedure };
  } catch {
    // Failure isolation: the lesson half stays persisted, the
    // procedure half degrades to `null`. Caller logs the reason.
    return { ...base, procedure: null };
  }
}

function parseProcedureLine(line: string): ParsedProcedure {
  const activationMatch = PROC_ACTIVATION_RE.exec(line);
  const stepsMatch = PROC_STEPS_RE.exec(line);
  if (!activationMatch) {
    throw new ProcedureDistillParseError(
      "missing_activation",
      "PROCEDURE line missing activation",
    );
  }
  if (!stepsMatch) {
    throw new ProcedureDistillParseError(
      "missing_steps",
      "PROCEDURE line missing steps",
    );
  }
  const activation = activationMatch[1]!.trim();
  if (activation.length === 0 || activation.length > PROCEDURE_ACTIVATION_MAX_LENGTH) {
    throw new ProcedureDistillParseError(
      activation.length === 0 ? "missing_activation" : "oversized_activation",
      `procedure activation must be 1..${PROCEDURE_ACTIVATION_MAX_LENGTH} chars`,
    );
  }
  const rawSteps = stepsMatch[1]!;
  const steps = parseStepsString(rawSteps);
  if (steps.length < PROCEDURE_MIN_STEPS) {
    throw new ProcedureDistillParseError(
      "too_few_steps",
      `procedure must have at least ${PROCEDURE_MIN_STEPS} steps`,
    );
  }
  if (steps.length > PROCEDURE_MAX_STEPS) {
    throw new ProcedureDistillParseError(
      "too_many_steps",
      `procedure must have at most ${PROCEDURE_MAX_STEPS} steps`,
    );
  }
  const tags: string[] = [];
  // The PROCEDURE_TAGS_RE deliberately scans the substring **after**
  // the `steps="..."` block so it does not match a stray `tags=`
  // accidentally embedded in the steps body.
  const afterSteps = line.slice(stepsMatch.index + stepsMatch[0].length);
  const tagsMatch = PROC_TAGS_RE.exec(afterSteps);
  if (tagsMatch) {
    for (const t of parseProcedureTags(tagsMatch[1]!)) {
      if (!tags.includes(t)) tags.push(t);
      if (tags.length >= PROCEDURE_MAX_TAGS) break;
    }
  }
  return { activation, steps, tags };
}

function parseStepsString(raw: string): ProcedureStep[] {
  const out: ProcedureStep[] = [];
  for (const token of raw.split(/\s*;\s*/)) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const atIdx = trimmed.lastIndexOf("@");
    let description = trimmed;
    let toolHint: string | null = null;
    if (atIdx > 0) {
      description = trimmed.slice(0, atIdx).trim();
      const candidate = trimmed.slice(atIdx + 1).trim();
      if (candidate.length > 0) {
        if (candidate.length > PROCEDURE_TOOL_HINT_MAX_LENGTH) {
          throw new ProcedureDistillParseError(
            "oversized_tool_hint",
            `tool hint exceeds ${PROCEDURE_TOOL_HINT_MAX_LENGTH} chars`,
          );
        }
        if (!TOOL_HINT_TOKEN_RE.test(candidate)) {
          throw new ProcedureDistillParseError(
            "malformed_tool_hint",
            `tool hint must match ${TOOL_HINT_TOKEN_RE}`,
          );
        }
        toolHint = candidate;
      }
    }
    if (description.length === 0) continue;
    if (description.length > PROCEDURE_DESCRIPTION_MAX_LENGTH) {
      throw new ProcedureDistillParseError(
        "oversized_step",
        `step description exceeds ${PROCEDURE_DESCRIPTION_MAX_LENGTH} chars`,
      );
    }
    out.push({ description, toolHint });
  }
  return out;
}

const PROC_TAG_TOKEN_RE = /^[a-z][a-z0-9_\-]{0,39}$/;

function parseProcedureTags(raw: string): string[] {
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 40) continue;
    if (!PROC_TAG_TOKEN_RE.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
