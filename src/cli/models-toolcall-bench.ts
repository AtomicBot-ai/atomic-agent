import { getConfig, type AtomicAgentConfig } from "../config/index.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import {
  askManyModels,
  formatAnswers,
  formatBenchTable,
  runToolCallBench,
  type AskComplete,
  type BenchComplete,
  type RunToolCallBenchOptions,
} from "../llm/toolcall-bench/index.js";
import {
  buildSpecProviders,
  closeSpecProviders,
  parseModelSpecs,
  type BuiltSpecs,
} from "./models-bench-providers.js";
import { readCliOption } from "./models-handlers.js";

/** Output bound of a bench try: one small tool call needs little. */
const BENCH_MAX_TOKENS = 1024;
const ASK_MAX_TOKENS = 2048;
const DEFAULT_TRIES = 3;
const MAX_TRIES = 50;

/** Test seams: the config and the provider builder. */
export interface ModelsBenchDeps {
  config?: AtomicAgentConfig;
  build?: typeof buildSpecProviders;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
}

function readTries(args: readonly string[]): number | "invalid" {
  const raw = readCliOption([...args], "--tries");
  if (raw === undefined) return DEFAULT_TRIES;
  if (!/^[1-9]\d*$/.test(raw.trim())) return "invalid";
  return Math.min(Number(raw), MAX_TRIES);
}

async function withProviders(
  args: readonly string[],
  deps: ModelsBenchDeps,
  run: (built: BuiltSpecs, order: string[]) => Promise<number>,
): Promise<number> {
  const config = deps.config ?? getConfig();
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  const specs = parseModelSpecs(
    readCliOption([...args], "--models"),
    resolveLlmConfig(config).activeTextProvider,
  );
  const built = await (deps.build ?? buildSpecProviders)(config, specs);
  for (const r of built.refused) writeErr(`skipped ${r.spec}: ${r.reason}\n`);
  const order = specs.map((s) => s.spec).filter((s) => built.providers.has(s));
  if (order.length === 0) {
    writeErr("no model to run\n");
    return 1;
  }
  try {
    return await run(built, order);
  } finally {
    await closeSpecProviders(built.providers);
  }
}

function providerOf(built: BuiltSpecs, spec: string): LlmProvider {
  const provider = built.providers.get(spec);
  if (!provider) throw new Error(`no provider built for ${spec}`);
  return provider;
}

/**
 * `atomic-agent models toolcall-bench [--models a,b] [--tries n] [--json]`
 * (ATO-1092): send the fixed tool-call prompts to each model `n` times
 * and print how often the call had valid JSON, the right tool and every
 * required argument. Exit 1 when no model could be run.
 */
export async function runModelsToolcallBench(
  args: readonly string[],
  deps: ModelsBenchDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  const tries = readTries(args);
  if (tries === "invalid") {
    writeErr("--tries needs a whole number above 0\n");
    return 2;
  }
  const json = args.includes("--json");
  return withProviders(args, deps, async (built, order) => {
    const toolless = order.filter(
      (spec) => providerOf(built, spec).capabilities.toolTransport !== "native_tools",
    );
    for (const spec of toolless) writeErr(`skipped ${spec}: this link does not take native tools\n`);
    const models = order.filter((spec) => !toolless.includes(spec));
    if (models.length === 0) {
      writeErr("no model to run\n");
      return 1;
    }
    const complete: BenchComplete = async (model, request) => {
      const result = await providerOf(built, model).complete({
        prompt: request.prompt,
        tools: request.tools as unknown as ReadonlyArray<Record<string, unknown>>,
        toolChoice: "auto",
        parallelToolCalls: false,
        maxTokens: BENCH_MAX_TOKENS,
      });
      return { content: result.content, toolCalls: result.toolCalls };
    };
    const onTry: RunToolCallBenchOptions["onTry"] = json
      ? undefined
      : ({ model, caseId, attempt, outcome }) => writeErr(`${model} ${caseId} #${attempt}: ${outcome}\n`);
    const results = await runToolCallBench({ models, tries, complete, onTry });
    write(json ? `${JSON.stringify(results)}\n` : formatBenchTable(results));
    return 0;
  });
}

/**
 * `atomic-agent models ask "<prompt>" [--models a,b] [--json]` (ATO-487 in
 * ATO-1092): one question, no tools, to every named model at once; the
 * answers are printed one after another under each model's name. Exit 1
 * when every model failed.
 */
export async function runModelsAsk(
  args: readonly string[],
  deps: ModelsBenchDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  const prompt = promptOf(args);
  if (prompt === "") {
    writeErr('usage: atomic-agent models ask "<question>" --models <provider[:model]>,...\n');
    return 2;
  }
  const json = args.includes("--json");
  return withProviders(args, deps, async (built, order) => {
    const complete: AskComplete = async (model, text) => {
      const result = await providerOf(built, model).complete({ prompt: text, maxTokens: ASK_MAX_TOKENS });
      return result.content;
    };
    const answers = await askManyModels({ models: order, prompt, complete });
    write(json ? `${JSON.stringify(answers)}\n` : formatAnswers(answers));
    return answers.some((a) => a.error === undefined) ? 0 : 1;
  });
}

/** The words of `args` that are not flags or flag values, joined. */
export function promptOf(args: readonly string[]): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--models") {
      i += 1;
      continue;
    }
    if (arg === "--json") continue;
    words.push(arg);
  }
  return words.join(" ").trim();
}
