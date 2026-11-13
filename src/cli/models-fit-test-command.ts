/**
 * `models fit-test --tasks <file> --models <a,b[,c]> --judge-url <url>`
 * (ATO-1090): run the user's own task set (`models tasks collect`) on up
 * to three local models, one at a time, score every reply with a judge,
 * and print a table of score, time and peak memory per model.
 *
 * Each model is made active and started through the same handlers as
 * `models use` / `models start`, then stopped. When the run ends the
 * model that was active before is put back, and started again if it
 * was running. Every task runs in a temp working dir and a temp state
 * dir with approvals refused (`fit-test/agent-task-runner.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import {
  createAgentTaskRunner,
  createFitJudge,
  formatFitTable,
  parseFitTaskSet,
  readProcessRssBytes,
  runFitTest,
  type FitTestDeps,
  type LoadedFitModel,
} from "../fit-test/index.js";
import { getDaemonStatus } from "../local-llm/index.js";
import { readRecommendSnapshot } from "../local-llm/model-upgrade-runner.js";
import {
  readCliOption,
  runLocalModelsStart,
  runLocalModelsStop,
  runLocalModelsUse,
} from "./models-handlers.js";
import { runModelsFitCompare } from "./models-fit-compare-command.js";

const MAX_MODELS = 3;
const DEFAULT_TIMEOUT_S = 300;

export const FIT_TEST_USAGE =
  "usage: atomic-agent models fit-test --tasks <file> --models <id,id[,id]> --judge-url <url>\n" +
  "         [--judge-model <id>] [--judge-key-env <ENV_NAME>] [--timeout <seconds>] [--out <file>] [--json]\n";

export interface FitTestArgs {
  tasksPath: string;
  modelIds: string[];
  judgeUrl: string;
  judgeModel: string;
  judgeKeyEnv: string | null;
  timeoutMs: number;
  outPath: string | null;
  json: boolean;
}

export function parseFitTestArgs(args: string[]): FitTestArgs | { error: string } {
  const tasksPath = readCliOption(args, "--tasks");
  if (!tasksPath) return { error: "--tasks <file> is required (write one with `models tasks collect`)" };
  const modelIds = [...new Set((readCliOption(args, "--models") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (modelIds.length === 0) return { error: "--models needs one to three model ids, comma separated" };
  if (modelIds.length > MAX_MODELS) return { error: `--models takes at most ${MAX_MODELS} models` };
  const judgeUrl = readCliOption(args, "--judge-url");
  if (!judgeUrl) return { error: "--judge-url is required: the judge reads your prompts, so choose where they go" };
  const timeoutRaw = readCliOption(args, "--timeout");
  const timeoutS = timeoutRaw === undefined ? DEFAULT_TIMEOUT_S : Number(timeoutRaw);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) return { error: "--timeout needs a whole number of seconds" };
  return {
    tasksPath: resolve(tasksPath),
    modelIds,
    judgeUrl,
    judgeModel: readCliOption(args, "--judge-model") ?? "judge",
    judgeKeyEnv: readCliOption(args, "--judge-key-env") ?? null,
    timeoutMs: timeoutS * 1000,
    outPath: readCliOption(args, "--out") ? resolve(readCliOption(args, "--out") as string) : null,
    json: args.includes("--json"),
  };
}

async function chatDaemonStatus() {
  const cfg = getConfig();
  return getDaemonStatus(cfg.paths.localModelsDataDir, cfg.localModels.managed.port);
}

/** Makes `modelId` the active managed model and starts it. */
async function loadManagedModel(modelId: string): Promise<LoadedFitModel> {
  await runLocalModelsStop();
  if ((await runLocalModelsUse(modelId)) !== 0) throw new Error("unknown model id");
  if ((await runLocalModelsStart({})) !== 0) throw new Error("the model did not start (is it downloaded?)");
  resetConfigCache();
  const cfg = getConfig();
  const status = await chatDaemonStatus();
  return {
    url: cfg.localModels.url,
    apiKey: cfg.localModels.apiKey,
    pid: status.pid,
    release: async () => {
      await runLocalModelsStop();
    },
  };
}

/** Puts back the model that was active before the run. */
async function restoreModel(previous: string | null, wasRunning: boolean): Promise<void> {
  if (previous === null) return;
  await runLocalModelsUse(previous);
  if (wasRunning) await runLocalModelsStart({});
}

export async function runModelsFitTest(args: string[]): Promise<number> {
  if (args.includes("--compare")) return runModelsFitCompare(args);
  const parsed = parseFitTestArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${FIT_TEST_USAGE}`);
    return 2;
  }
  const cfg = getConfig();
  if (cfg.localModels.mode !== "managed") {
    process.stderr.write("fit-test loads models itself, so it needs managed mode (`atomic-agent models use <id>`)\n");
    return 1;
  }
  const set = parseFitTaskSet(JSON.parse(readFileSync(parsed.tasksPath, "utf8")));
  if (set.tasks.length === 0) {
    process.stderr.write("the task set is empty\n");
    return 1;
  }
  const judgeKey = parsed.judgeKeyEnv ? (process.env[parsed.judgeKeyEnv] ?? null) : null;
  const judge = createFitJudge({ url: parsed.judgeUrl, model: parsed.judgeModel, apiKey: judgeKey });
  const deps: FitTestDeps = {
    loadModel: loadManagedModel,
    runTask: (task, model) =>
      createAgentTaskRunner({ modelUrl: model.url, modelApiKey: model.apiKey, timeoutMs: parsed.timeoutMs })(task),
    judge: (task, reply) => judge(task.prompt, reply, task.expectations[0]?.rubric ?? ""),
    sampleMemory: readProcessRssBytes,
    progress: (line) => process.stderr.write(`${line}\n`),
  };
  const previous = cfg.localModels.managed.modelId;
  const wasRunning = (await chatDaemonStatus()).running;
  const gpuBudgetGb = await readRecommendSnapshot()
    .then((snap) => snap.machine.gpuBudgetGb)
    .catch(() => null);
  let run;
  try {
    run = await runFitTest(set, parsed.modelIds, deps, { gpuBudgetGb });
  } finally {
    await restoreModel(previous, wasRunning);
  }
  const body = `${JSON.stringify(run, null, 2)}\n`;
  if (parsed.outPath !== null) writeFileSync(parsed.outPath, body, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(parsed.json ? body : formatFitTable(run));
  return 0;
}
