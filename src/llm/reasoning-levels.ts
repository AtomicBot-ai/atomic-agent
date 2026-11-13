/**
 * The reasoning level a person picks for a chat (ATO-490): the composer's
 * Auto / Low / Medium / High switch, and what each level means per kind
 * of model.
 *
 * `auto` is no choice at all: the request carries nothing new and every
 * completion is built exactly as before (the model's `params`, a fusion
 * worker's `workerReasoning`, the service default). A real level is an
 * override for the turns of that chat:
 *
 *  - a cloud model that takes a reasoning effort gets it, in the field
 *    its kind reads (`reasoningEffortField`), over whatever the config's
 *    `params` / `extraBody` say. A model that does not reason (by the
 *    table below) gets nothing, so the switch can never turn a working
 *    request into a 400.
 *  - a local grammar-served thinking model gets a think-block budget
 *    (`LOCAL_REASONING_BUDGET_TOKENS`) in place of
 *    `localModels.reasoningBudgetTokens` for that turn.
 *
 * `reasoningControlFor` is the "what the model supports" table the
 * desktop reads (through `GET /api/capabilities`) to decide whether to
 * draw the switch at all.
 */

import type { ReasoningEffort } from "./provider/completion-types.js";
import { reasoningEffortField } from "./provider/openai/model-params.js";
import { reasoningBudgetChars } from "./reasoning-budget.js";
import { LLAMA_SERVER_GBNF_MAX_REPETITION } from "./grammar/reasoning-prelude.js";

export type ReasoningLevel = "auto" | ReasoningEffort;

/** Every level, in the order a switch offers them. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = ["auto", "low", "medium", "high"];

/**
 * A request's `reasoning_effort` read as a level override, or `undefined`
 * for none. Only `low`, `medium` and `high` override. `auto`, absent,
 * `null` and any other spelling (OpenAI's own `minimal`, `none`, `xhigh`
 * from a plain OpenAI client) are no override: the field was ignored
 * before this change, so an unknown value keeps being ignored rather than
 * failing a request that used to work.
 */
export function reasoningOverrideFromRequest(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

/**
 * The think-block budget of a local grammar-served model per level, in
 * budget tokens (`reasoning-budget.ts` units). `0` is no bound. High
 * lifts the bound entirely; Low and Medium sit around the low end and
 * the middle of what the fusion bench measured per tool step
 * (500 to 7,152 reasoning tokens).
 */
export const LOCAL_REASONING_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1_000,
  medium: 4_000,
  high: 0,
};

/**
 * Cloud model ids (after any router prefix) that reason and take an
 * effort: OpenAI o-series and GPT-5 on; Claude 3.7 Sonnet, Claude 4 and
 * later, every Fable and Mythos; Gemini 2.5 and 3.x; DeepSeek R1 and the
 * reasoner alias; Grok 3 Mini and Grok 4 on; Qwen3 and QwQ; Kimi
 * thinking and K3; GLM 4.5 on; MiniMax M2; gpt-oss. A model missing
 * here just gets no switch (Auto), never a wrong request.
 */
const REASONING_MODEL_RES: readonly RegExp[] = [
  /^(?:o[1-9](?![a-z])|gpt-[5-9](?![0-9a-z]))/i,
  /^gpt-oss/i,
  /^(?:[a-z]+\.)?(?:anthropic\.)?claude-(?:3[-.]7-sonnet|(?:opus|sonnet)-(?:[4-9]|[1-9][0-9])|haiku-(?:4[-.]5|[5-9]|[1-9][0-9])|fable|mythos)(?![0-9])/i,
  /^(?:models\/)?gemini-(?:2\.5|[3-9])(?![0-9])/i,
  /^deepseek-(?:r1|reasoner)/i,
  /^grok-(?:3-mini|[4-9])/i,
  /^(?:qwen3|qwq)/i,
  /^kimi-(?:k2-thinking|k3)/i,
  /^glm-(?:4\.[5-9]|[5-9])/i,
  /^minimax-m2/i,
];

/** OpenAI ids that are not reasoners even though their family is (`gpt-5-chat-latest`). */
const NON_REASONING_VARIANT_RE = /-chat(?![a-z])|(?:image|tts|audio|live|embedding)/i;

function bareModelId(modelId: string): string {
  return modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
}

/** Whether a cloud model id reasons, by the table above. */
export function cloudModelReasons(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const bare = bareModelId(modelId.trim());
  if (NON_REASONING_VARIANT_RE.test(bare)) return false;
  return REASONING_MODEL_RES.some((re) => re.test(bare));
}

/**
 * Whether a person's level reaches this cloud request: the kind has an
 * effort field (`reasoningEffortField` spells one) and the model reasons.
 */
export function cloudTakesReasoningOverride(
  providerKind: string | undefined,
  modelId: string | undefined,
): boolean {
  if (!cloudModelReasons(modelId)) return false;
  return Object.keys(reasoningEffortField(providerKind, "medium", modelId)).length > 0;
}

/**
 * How the switch acts on a route: `effort` (a cloud reasoning effort),
 * `budget` (a local think-block budget), `none` (the model cannot
 * reason here, so no switch is drawn).
 */
export type ReasoningControl = "effort" | "budget" | "none";

export function reasoningControlFor(route: {
  providerKind: string | undefined;
  modelId: string | undefined;
  /** For a `llama-server` route: the loaded model thinks inside a grammar prelude. */
  localThinks?: boolean;
}): ReasoningControl {
  if (route.providerKind === "llama-server") return route.localThinks === true ? "budget" : "none";
  return cloudTakesReasoningOverride(route.providerKind, route.modelId) ? "effort" : "none";
}

/** The levels a switch offers for a control: all four, or just Auto. */
export function reasoningLevelsFor(control: ReasoningControl): readonly ReasoningLevel[] {
  return control === "none" ? ["auto"] : REASONING_LEVELS;
}

/** `root ::= X-prelude tool-call-array`: the grammar thinks first. */
const PRELUDE_ROOT_RE = /^root ::= ([a-z]+)-prelude tool-call-array$/m;

/** An unbounded fragment's lead alternative, `[^c]+` (`c` may be escaped). */
const FRAGMENT_LEAD_RE = /^(\[\^(?:\\.|[^\]\\])+\])\+/;

/** The same cap `reasoning-prelude.ts` chains under (llama.cpp's 1,999). */
const GBNF_MAX_REPETITION = LLAMA_SERVER_GBNF_MAX_REPETITION;

function boundedBody(stem: string, chars: number): string[] {
  const unit = `${stem}-char`;
  const rules: string[] = [];
  let name = `${stem}-body`;
  let remaining = chars;
  let link = 2;
  while (remaining > GBNF_MAX_REPETITION) {
    const next = `${stem}-body-${link}`;
    rules.push(`${name} ::= ${unit}{0,${GBNF_MAX_REPETITION - 1}} | ${unit}{${GBNF_MAX_REPETITION}} ${next}`);
    name = next;
    remaining -= GBNF_MAX_REPETITION;
    link += 1;
  }
  rules.push(`${name} ::= ${unit}{0,${remaining}}`);
  return rules;
}

/**
 * The grammar with its think-block bound set to `budgetTokens` (`0` = no
 * bound), for a turn whose person picked a level. A grammar without a
 * reasoning prelude (a model that does not think, `thinking: off`) is
 * returned unchanged, the same string. The body rules are rewritten in
 * place of the old ones, every other line stays as it was; an unbounded
 * body gains the single-character unit it needs to count.
 */
export function withReasoningBudget(grammar: string, budgetTokens: number): string {
  const root = PRELUDE_ROOT_RE.exec(grammar);
  if (!root) return grammar;
  const stem = root[1]!;
  const lines = grammar.split("\n");
  const bodyAt = lines.findIndex((l) => l.startsWith(`${stem}-body ::= `));
  if (bodyAt < 0) return grammar;
  const charLine = lines.find((l) => l.startsWith(`${stem}-char ::= `));
  const fragmentLine = lines.find((l) => l.startsWith(`${stem}-fragment ::= `));
  const chars = reasoningBudgetChars(budgetTokens);
  const extra: string[] = [];
  let body: string[];
  if (chars === 0) {
    // Unbounded: whichever unit the grammar defines, repeated freely.
    body = [`${stem}-body ::= ${charLine ? `${stem}-char` : `${stem}-fragment`}*`];
  } else {
    if (!charLine) {
      // The unbounded fragment's lead `[^c]+` becomes the one-character `[^c]`
      // (`buildReasoningPreludeRules` builds the bounded unit the same way).
      const rhs = fragmentLine?.slice(`${stem}-fragment ::= `.length);
      const lead = rhs === undefined ? null : FRAGMENT_LEAD_RE.exec(rhs);
      if (rhs === undefined || !lead) return grammar;
      extra.push(`${stem}-char ::= ${lead[1]}${rhs.slice(lead[0].length)}`);
    }
    body = boundedBody(stem, chars);
  }
  const chained = new RegExp(`^${stem}-body-\\d+ ::= `);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (i === bodyAt) out.push(...body, ...extra);
    else if (!chained.test(line)) out.push(line);
  });
  return out.join("\n");
}
