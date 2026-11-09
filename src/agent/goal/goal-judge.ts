import { buildCloudSubcallRequest } from "../../llm/provider/cloud-subcall.js";
import type {
  CompletionRequest,
  CompletionResult,
  ToolCallTransport,
} from "../../llm/provider/completion-types.js";
import type { GoalCheckResult, GoalCriterionMark } from "./goal-types.js";

/**
 * The goal judge: one short, strict sub-call after a round whose checks
 * passed. It reads the acceptance list and the agent's last reply and
 * answers met / not met / blocked per criterion, as JSON. Anything else
 * is "unreadable" and counts towards pausing the goal.
 */

export const GOAL_JUDGE_SYSTEM =
  "You judge whether work meets an acceptance list. Answer with JSON only.";
const GOAL_JUDGE_PREFIX_KEY = "goal-judge";
export const GOAL_JUDGE_SESSION_PREFIX = "goal-judge:";
const GOAL_JUDGE_MAX_TOKENS = 1_024;
/** Characters of the agent's reply the judge reads. */
const REPLY_MAX_CHARS = 6_000;

export interface GoalJudgeInput {
  criteria: readonly string[];
  /** The agent's reply that ended the round; empty when there was none. */
  reply: string;
  /** Checks that ran this round (all passed, or the judge would not run). */
  checks: readonly GoalCheckResult[];
}

/** One judged criterion, in list order. */
export interface GoalJudgedCriterion {
  mark: Exclude<GoalCriterionMark, "pending">;
  reason: string;
}

export function buildGoalJudgePrompt(input: GoalJudgeInput): string {
  const list = input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const reply = input.reply.trim().length === 0
    ? "(the agent did not reply)"
    : clip(input.reply.trim(), REPLY_MAX_CHARS);
  const checks = input.checks.length === 0
    ? "none configured"
    : input.checks.map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`).join("\n");
  return [
    "Acceptance list:",
    list,
    "",
    "Shell checks this round:",
    checks,
    "",
    "The agent's report at the end of this round:",
    reply,
    "",
    "For every item decide:",
    '- "met": the report gives concrete evidence it is done (files, output, passing checks).',
    '- "not_met": it is not done yet, or the evidence is missing or vague.',
    '- "blocked": the agent cannot go on without a person (a decision, access, a credential, hardware).',
    "Be strict: a claim without evidence is not_met.",
    'Answer with one JSON object and nothing else: {"criteria":[{"index":1,"verdict":"met","reason":"one line"}]}',
    `with exactly ${input.criteria.length} entries, one per item, in order.`,
  ].join("\n");
}

/** JSON schema for the native-tools emit function. */
const GOAL_JUDGE_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["met", "not_met", "blocked"] },
          reason: { type: "string" },
        },
        required: ["index", "verdict", "reason"],
      },
    },
  },
  required: ["criteria"],
};

/**
 * The completion request for one judge call, shaped for the link that
 * serves it: a single emit function on a native-tools (cloud) link, the
 * model's own chat template with thinking off on a local one. Same
 * pattern as the session namer (`session-title.ts`).
 */
export function buildGoalJudgeRequest(params: {
  prompt: string;
  sessionId: string;
  transport: ToolCallTransport;
  slotId: number;
  serverTemplate: boolean;
}): CompletionRequest & { grammar: string; slotId: number; sessionId: string } {
  const sessionId = `${GOAL_JUDGE_SESSION_PREFIX}${params.sessionId}`;
  if (params.transport === "native_tools") {
    return {
      ...buildCloudSubcallRequest({
        prompt: params.prompt,
        emitFunctionName: "emit_goal_verdict",
        argsSchema: GOAL_JUDGE_EMIT_SCHEMA,
        description: "Emit the verdict for every acceptance item",
        sessionId,
        maxTokens: GOAL_JUDGE_MAX_TOKENS,
      }),
      sessionId,
      grammar: "",
      slotId: -1,
    };
  }
  return {
    prompt: params.prompt,
    sessionId,
    grammar: "",
    slotId: params.slotId,
    maxTokens: GOAL_JUDGE_MAX_TOKENS,
    ...(params.serverTemplate
      ? {
          chat: {
            system: GOAL_JUDGE_SYSTEM,
            user: params.prompt,
            prefixHash: GOAL_JUDGE_PREFIX_KEY,
            enableThinking: false,
          },
        }
      : {}),
  };
}

/** The judge's text: the emit function's arguments, else the prose answer. */
export function extractGoalJudgeText(
  completion: Pick<CompletionResult, "content" | "toolCalls">,
): string {
  const args = completion.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.trim().length > 0) return args;
  return completion.content ?? "";
}

/**
 * Read a verdict for `count` criteria, or `null` when the answer is not
 * one. Tolerates reasoning blocks and code fences around the JSON; does
 * not tolerate missing items, unknown verdicts or extra prose inside it.
 */
export function parseGoalVerdict(
  text: string,
  count: number,
): GoalJudgedCriterion[] | null {
  const json = extractJsonObject(text);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const list = (parsed as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(list)) return null;
  const out: (GoalJudgedCriterion | undefined)[] = new Array(count).fill(undefined);
  list.forEach((entry, position) => {
    if (entry === null || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const index = typeof e.index === "number" ? e.index - 1 : position;
    const mark = normalizeMark(e.verdict);
    if (mark === null || index < 0 || index >= count || out[index] !== undefined) return;
    const reason = typeof e.reason === "string" ? oneLine(e.reason) : "";
    out[index] = { mark, reason };
  });
  return out.every((v) => v !== undefined) ? (out as GoalJudgedCriterion[]) : null;
}

function normalizeMark(value: unknown): GoalJudgedCriterion["mark"] | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "met" || v === "done" || v === "pass") return "met";
  if (v === "not_met" || v === "unmet" || v === "fail") return "not_met";
  if (v === "blocked") return "blocked";
  return null;
}

function extractJsonObject(text: string): string | null {
  const cleaned = text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start === -1 || end <= start ? null : cleaned.slice(start, end + 1);
}

function oneLine(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), 200);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
