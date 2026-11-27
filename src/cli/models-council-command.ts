import { getConfig } from "../config/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import {
  askManyModels,
  buildCouncilPrompt,
  councilMembers,
  formatAnswers,
  formatCouncilSummary,
  parseCouncilSummary,
  type AskComplete,
  type CouncilSummary,
  type ModelAnswer,
} from "../llm/toolcall-bench/index.js";
import {
  buildSpecProviders,
  closeSpecProviders,
  parseModelSpecs,
} from "./models-bench-providers.js";
import { readCliOption } from "./models-handlers.js";
import type { ModelsBenchDeps } from "./models-toolcall-bench.js";

const ANSWER_MAX_TOKENS = 2048;
/** The judge reads every answer and writes three short lists. */
const JUDGE_MAX_TOKENS = 2048;

const USAGE =
  'usage: atomic-agent models council "<question>" --models <provider[:model]>,... [--judge <provider[:model]>] [--json]\n';

/** What `--json` prints. */
export interface CouncilReport {
  question: string;
  answers: ModelAnswer[];
  judge: string;
  summary?: CouncilSummary;
  judgeError?: string;
}

/** The words of `args` that are not council flags or their values, joined. */
export function councilQuestionOf(args: readonly string[]): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--models" || arg === "--judge") {
      i += 1;
      continue;
    }
    if (arg === "--json" || arg === "--council") continue;
    words.push(arg);
  }
  return words.join(" ").trim();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `atomic-agent models council "<question>" --models a,b [--judge c] [--json]`,
 * also reached as `models ask --council` (ATO-2232): the question goes to
 * every listed model at once, as `models ask` does, then one judge model
 * (the first listed model unless `--judge` names another) reads the
 * answers under letters and lists what they agree on, where they disagree,
 * and what only one answer said. A `--judge` outside `--models` judges
 * without answering. Exit 0 with a summary, or with a single answer
 * (nothing to compare); exit 1 when every model failed or the judge did.
 */
export async function runModelsCouncil(
  args: readonly string[],
  deps: ModelsBenchDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  const question = councilQuestionOf(args);
  if (question === "") {
    writeErr(USAGE);
    return 2;
  }
  const json = args.includes("--json");
  const config = deps.config ?? getConfig();
  const active = resolveLlmConfig(config).activeTextProvider;
  const memberSpecs = parseModelSpecs(readCliOption([...args], "--models"), active);
  const judgeRaw = readCliOption([...args], "--judge")?.trim();
  const judgeSpec = judgeRaw ? parseModelSpecs(judgeRaw, active)[0] : undefined;
  const judgeOutside = judgeSpec !== undefined && !memberSpecs.some((s) => s.spec === judgeSpec.spec);
  const built = await (deps.build ?? buildSpecProviders)(
    config,
    judgeOutside && judgeSpec ? [...memberSpecs, judgeSpec] : memberSpecs,
  );
  for (const r of built.refused) writeErr(`skipped ${r.spec}: ${r.reason}\n`);
  try {
    const order = memberSpecs.map((s) => s.spec).filter((s) => built.providers.has(s));
    if (order.length === 0) {
      writeErr("no model to run\n");
      return 1;
    }
    const judge = judgeSpec?.spec ?? order[0]!;
    const judgeProvider = built.providers.get(judge);
    if (!judgeProvider) {
      writeErr(`no judge: ${judge} could not be built\n`);
      return 1;
    }
    const complete: AskComplete = async (model, text) => {
      const provider = built.providers.get(model);
      if (!provider) throw new Error(`no provider built for ${model}`);
      const result = await provider.complete({ prompt: text, maxTokens: ANSWER_MAX_TOKENS });
      return result.content;
    };
    const answers = await askManyModels({ models: order, prompt: question, complete });
    const report: CouncilReport = { question, answers, judge };
    const members = councilMembers(answers);
    if (members.length === 0) {
      writeErr("every model failed; nothing to judge\n");
    } else if (members.length === 1) {
      writeErr("only one answer; nothing to compare\n");
    } else {
      try {
        const reply = await judgeProvider.complete({
          prompt: buildCouncilPrompt(question, members),
          maxTokens: JUDGE_MAX_TOKENS,
        });
        report.summary = parseCouncilSummary(reply.content, members);
      } catch (err) {
        report.judgeError = errorText(err);
        writeErr(`judge ${judge} failed: ${report.judgeError}\n`);
      }
    }
    if (json) write(`${JSON.stringify(report)}\n`);
    else {
      write(formatAnswers(answers));
      if (report.summary) write(`\n${formatCouncilSummary(report.summary, judge)}`);
    }
    if (members.length === 0 || report.judgeError !== undefined) return 1;
    return 0;
  } finally {
    await closeSpecProviders(built.providers);
  }
}
