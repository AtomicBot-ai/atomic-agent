/**
 * A clarifying question the agent asks the user mid-turn (`ask_user`,
 * ATO-489): a prompt plus ready answers to click, one or several, and
 * optionally an "Other" answer in the user's own words.
 *
 * It travels as an `ApprovalRequest` of category `user_question` with
 * this object in `request.question`, so the turn pauses exactly where an
 * approval pauses it and every surface that already receives approvals
 * (the TUI prompt, `GET /api/events` for the desktop, a Telegram chat)
 * receives the question too. The answer comes back in
 * `ApprovalDecision.answer`; a Deny is "skip the question".
 */
export interface UserQuestionOption {
  label: string;
  /** One line under the label: what picking it means. */
  description?: string;
}

export interface UserQuestion {
  /** The question itself, one or two sentences. */
  prompt: string;
  /** At least two, at most `USER_QUESTION_MAX_OPTIONS`, labels unique. */
  options: UserQuestionOption[];
  /** True: the user may pick several options. */
  multiSelect: boolean;
  /** True: the user may type their own answer instead ("Other"). */
  allowOther: boolean;
}

export interface UserQuestionAnswer {
  /** Labels of the options picked, in the order the question lists them. */
  selected: string[];
  /** The user's own words, when they answered "Other". */
  other?: string;
}

export const USER_QUESTION_MIN_OPTIONS = 2;
export const USER_QUESTION_MAX_OPTIONS = 8;
export const USER_QUESTION_PROMPT_MAX = 600;
export const USER_QUESTION_LABEL_MAX = 80;
export const USER_QUESTION_DESCRIPTION_MAX = 200;
export const USER_QUESTION_OTHER_MAX = 2_000;

/** The tool that asks; its requests carry category `user_question`. */
export const ASK_USER_TOOL = "ask_user";

/**
 * Check an answer against the question it answers. Returns the answer
 * cleaned up (labels in the question's order, deduplicated, `other`
 * trimmed) or an error string naming what is wrong. A surface's answer
 * goes through this before it reaches the model, so a stale or forged
 * answer cannot name an option the question never offered.
 */
export function validateUserQuestionAnswer(
  question: UserQuestion,
  raw: { selected?: unknown; other?: unknown },
): UserQuestionAnswer | string {
  const picked = raw.selected ?? [];
  if (!Array.isArray(picked)) return "selected must be a list of option labels";
  const wanted = new Set<string>();
  for (const item of picked) {
    const label = resolveOptionLabel(question, item);
    if (label === null) return `not an option of this question: ${String(item)}`;
    wanted.add(label);
  }
  let other: string | undefined;
  if (raw.other !== undefined && raw.other !== null) {
    if (typeof raw.other !== "string") return "other must be a string";
    const trimmed = raw.other.trim();
    if (trimmed.length > 0) other = trimmed.slice(0, USER_QUESTION_OTHER_MAX);
  }
  if (other !== undefined && !question.allowOther) {
    return "this question takes no answer of your own; pick an option";
  }
  if (!question.multiSelect && wanted.size > 1) {
    return "this question takes one option";
  }
  if (wanted.size === 0 && other === undefined) {
    return "pick an option or type an answer";
  }
  const selected = question.options.map((o) => o.label).filter((l) => wanted.has(l));
  return other === undefined ? { selected } : { selected, other };
}

/** A label, or a 0-based index into the options (what a button sends). */
function resolveOptionLabel(question: UserQuestion, item: unknown): string | null {
  if (typeof item === "number" && Number.isInteger(item)) {
    return question.options[item]?.label ?? null;
  }
  if (typeof item !== "string") return null;
  const match = question.options.find((o) => o.label === item.trim());
  return match?.label ?? null;
}

/**
 * Read what a person typed at a text surface (the TUI composer, a chat
 * reply) as an answer: `2`, `1,3` or `1 3` pick options by their number;
 * anything else is the "Other" answer. Returns an error string when the
 * text cannot be an answer to this question.
 */
export function parseTypedUserQuestionAnswer(
  question: UserQuestion,
  text: string,
): UserQuestionAnswer | string {
  const trimmed = text.trim();
  if (/^\d+(\s*[, ]\s*\d+)*$/.test(trimmed)) {
    const indexes = trimmed.split(/[\s,]+/).map((n) => Number(n) - 1);
    if (indexes.some((i) => i < 0 || i >= question.options.length)) {
      return `pick a number from 1 to ${question.options.length}`;
    }
    return validateUserQuestionAnswer(question, { selected: indexes });
  }
  return validateUserQuestionAnswer(question, { other: trimmed });
}

/** The question as plain lines: for a preview and for text-only surfaces. */
export function renderUserQuestionText(question: UserQuestion): string {
  const lines = question.options.map((o, i) =>
    o.description ? `${i + 1}. ${o.label} - ${o.description}` : `${i + 1}. ${o.label}`,
  );
  const how = question.multiSelect ? "Pick one or more" : "Pick one";
  lines.push(question.allowOther ? `${how}, or answer in your own words.` : `${how}.`);
  return lines.join("\n");
}

/** What the model reads back: `Picked: A, B. Own answer: "..."`. */
export function describeUserQuestionAnswer(answer: UserQuestionAnswer): string {
  const parts: string[] = [];
  if (answer.selected.length > 0) parts.push(`Picked: ${answer.selected.join(", ")}.`);
  if (answer.other !== undefined) parts.push(`Own answer: ${JSON.stringify(answer.other)}.`);
  return parts.join(" ");
}
