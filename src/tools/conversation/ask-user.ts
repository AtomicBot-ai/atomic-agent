import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  ASK_USER_TOOL,
  describeUserQuestionAnswer,
  renderUserQuestionText,
  USER_QUESTION_DESCRIPTION_MAX,
  USER_QUESTION_LABEL_MAX,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MIN_OPTIONS,
  USER_QUESTION_PROMPT_MAX,
  validateUserQuestionAnswer,
  type UserQuestion,
  type UserQuestionAnswer,
  type UserQuestionOption,
} from "../../approval/user-question.js";
import type { ToolDefinition } from "../tool-registry.js";

/** Key of the answer in the result's `details`, for hosts and traces. */
export const USER_ANSWER_DETAIL = "userAnswer";

/**
 * Read the model's arguments into a question, or throw a message the
 * model can act on. Labels are trimmed and deduplicated, overlong text
 * is cut, and `allowOther` defaults to true: a person whose answer is
 * not among the options must still be able to say it.
 */
export function normalizeUserQuestion(raw: Record<string, unknown>): UserQuestion {
  const prompt = typeof raw.question === "string" ? raw.question.trim() : "";
  if (prompt.length === 0) {
    throw new Error("ask_user: `question` must be a non-empty string");
  }
  if (!Array.isArray(raw.options)) {
    throw new Error("ask_user: `options` must be a list of { label, description? }");
  }
  const options: UserQuestionOption[] = [];
  const seen = new Set<string>();
  for (const item of raw.options) {
    const entry: Record<string, unknown> =
      typeof item === "string" ? { label: item } : (item as Record<string, unknown>) ?? {};
    const label =
      typeof entry.label === "string" ? entry.label.trim().slice(0, USER_QUESTION_LABEL_MAX) : "";
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    const description =
      typeof entry.description === "string"
        ? entry.description.trim().slice(0, USER_QUESTION_DESCRIPTION_MAX)
        : "";
    options.push(description ? { label, description } : { label });
  }
  if (options.length < USER_QUESTION_MIN_OPTIONS || options.length > USER_QUESTION_MAX_OPTIONS) {
    throw new Error(
      `ask_user: give ${USER_QUESTION_MIN_OPTIONS} to ${USER_QUESTION_MAX_OPTIONS} options with distinct labels (got ${options.length})`,
    );
  }
  return {
    prompt: prompt.slice(0, USER_QUESTION_PROMPT_MAX),
    options,
    multiSelect: raw.multiSelect === true,
    allowOther: raw.allowOther !== false,
  };
}

const NO_ONE_TO_ASK =
  "Nobody can answer right now. Do not ask again this turn: go on with the option that fits the request best and say in your reply which one you assumed.";

/**
 * `ask_user` (ATO-489): stop and ask the user a clarifying question with
 * ready answers. The question goes through the approval gate as a
 * `user_question` request, so the turn waits exactly as it waits for an
 * approval, on whichever surface owns the session, and nothing but the
 * person answers it: no approval level, grant or rule does
 * (`approval-level.ts`). The answer is the tool result.
 *
 * A session nobody watches (a fusion worker, a background task) gets the
 * gate's automatic refusal at once and the model is told to go on with
 * its best guess, so a question never parks an unattended turn.
 */
export function buildAskUserTool(deps: {
  approvals: Pick<ApprovalGate, "request">;
  /**
   * Whether the session's running turn is on a surface that shows a
   * question card (`surfaceShowsQuestions`). The tool is hidden from
   * the others, but a model can still call it (copied from history):
   * then it answers at once, the same as an unattended session, and no
   * question is raised (ATO-489; the desktop until ATO-1502). Absent:
   * every session can ask.
   */
  canAsk?: (sessionId: string) => boolean;
}): ToolDefinition {
  return {
    name: ASK_USER_TOOL,
    description:
      "Ask the user a clarifying question with 2-8 ready answers (one or several, plus their own words) and wait for the answer.",
    // Changes nothing: it may run in plan mode, where asking first is the point.
    readonly: true,
    async run(rawArgs, ctx) {
      if (deps.canAsk !== undefined && !deps.canAsk(ctx.sessionId)) {
        return compressToolResult(
          { tool: ASK_USER_TOOL, status: "ok", output: NO_ONE_TO_ASK, details: {} },
          { maxSummaryLength: 4_000 },
        );
      }
      const question = normalizeUserQuestion(rawArgs);
      const decision = await deps.approvals.request(
        {
          sessionId: ctx.sessionId,
          tool: ASK_USER_TOOL,
          category: "user_question",
          reason: question.prompt,
          preview: renderUserQuestionText(question),
          question,
        },
        { signal: ctx.signal },
      );
      let output: string;
      let answer: UserQuestionAnswer | null = null;
      if (!decision.approved) {
        const words = decision.reason?.trim() ?? "";
        if (decision.automatic === true && decision.declinedEarlier !== true) {
          output = `${NO_ONE_TO_ASK}${words ? ` (${words})` : ""}`;
        } else if (words && decision.declinedEarlier !== true) {
          output = `The user did not pick an option and said instead: ${words}`;
        } else {
          output =
            "The user skipped this question. Do not ask it again: go on with the option that fits best and say which one you assumed.";
        }
      } else {
        const checked =
          decision.answer === undefined
            ? null
            : validateUserQuestionAnswer(question, decision.answer);
        if (checked === null || typeof checked === "string") {
          output =
            "The question was closed without an answer. Go on with the option that fits best and say which one you assumed.";
        } else {
          answer = checked;
          output = `The user answered: ${describeUserQuestionAnswer(checked)}`;
        }
      }
      return compressToolResult(
        {
          tool: ASK_USER_TOOL,
          status: "ok",
          output,
          details: answer === null ? {} : { [USER_ANSWER_DETAIL]: answer },
        },
        { maxSummaryLength: 4_000 },
      );
    },
  };
}
