import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig, type AtomicAgentConfig } from "../config/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { estimateUsageCostUsd } from "../llm/provider/usage-cost.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { resolveModelPricingFor } from "../runtime/resolve-model-pricing.js";
import { resolveStarterSkillsSourceDir } from "../skills/seed-starter-skills.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import {
  createSkillEvalJudge,
  findSkillTasksFile,
  listSkillsWithTasks,
  loadTaskSet,
  resolveJudgeConfig,
  taskSetUsesJudge,
  runSkillEval,
  saveSkillEvalResult,
  SKILL_EVAL_VARIANTS,
  type SkillEvalDriver,
  type SkillEvalJudge,
  type SkillEvalJudgeConfig,
  type SkillEvalDriverRun,
  type SkillEvalResult,
  type SkillEvalTaskSet,
  type SkillEvalVariant,
} from "../skills/eval/index.js";
import { getAppVersion } from "../version.js";
import { formatSkillEvalOverview, formatSkillEvalSummary } from "./skill-eval-format.js";

export { formatSkillEvalOverview, formatSkillEvalSummary } from "./skill-eval-format.js";

export const SKILL_EVAL_USAGE =
  "usage: atomic-agent skill eval <skill> [--tasks <tasks.yaml>] | --all  [--check-tasks] [--repeat <n>] [--only with|without] [--max-steps <n>] [--no-approval] [--json] [--keep-workdir] [--judge-url <url>] [--judge-model <id>]\n";

export interface SkillEvalArgs {
  /** Null with `--all`. */
  skill: string | null;
  /** Null: found next to the skill (`findSkillTasksFile`). */
  tasksFile: string | null;
  /** `--all`: every skill that has a tasks file (ATO-1163). */
  all: boolean;
  /** `--check-tasks`: print where the tasks file is and exit, run nothing. */
  checkTasks: boolean;
  repeat: number;
  variants: SkillEvalVariant[];
  maxSteps: number | null;
  noApproval: boolean;
  json: boolean;
  keepWorkdir: boolean;
  /** `--judge-url` / `--judge-model`; null falls back to ATOMIC_AGENT_JUDGE_URL / _MODEL. */
  judgeUrl: string | null;
  judgeModel: string | null;
}

export function parseSkillEvalArgs(args: string[]): SkillEvalArgs | { error: string } {
  let skill: string | null = null;
  let tasksFile: string | null = null;
  let all = false;
  let checkTasks = false;
  let repeat = 1;
  let variants: SkillEvalVariant[] = [...SKILL_EVAL_VARIANTS];
  let maxSteps: number | null = null;
  let noApproval = false;
  let json = false;
  let keepWorkdir = false;
  let judgeUrl: string | null = null;
  let judgeModel: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = (): string | null => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    switch (arg) {
      case "--tasks": {
        tasksFile = value();
        if (tasksFile === null) return { error: "--tasks requires a file" };
        break;
      }
      case "--repeat":
      case "--max-steps": {
        const raw = value();
        const n = raw === null ? NaN : Number(raw);
        if (!Number.isInteger(n) || n <= 0) return { error: `${arg} expects a positive integer` };
        if (arg === "--repeat") repeat = n;
        else maxSteps = n;
        break;
      }
      case "--only": {
        const v = value();
        if (v !== "with" && v !== "without") return { error: "--only expects with or without" };
        variants = [v];
        break;
      }
      case "--judge-url":
      case "--judge-model": {
        const v = value();
        if (v === null) return { error: `${arg} requires a value` };
        if (arg === "--judge-url") judgeUrl = v;
        else judgeModel = v;
        break;
      }
      case "--all":
        all = true;
        break;
      case "--check-tasks":
        checkTasks = true;
        break;
      case "--no-approval":
        noApproval = true;
        break;
      case "--json":
        json = true;
        break;
      case "--keep-workdir":
        keepWorkdir = true;
        break;
      default:
        if (arg.startsWith("-")) return { error: `unknown flag: ${arg}` };
        if (skill !== null) return { error: `unexpected argument: ${arg}` };
        skill = arg;
    }
  }
  if (all && skill !== null) return { error: "--all evaluates every skill with a tasks file; leave out <skill>" };
  if (all && tasksFile !== null) return { error: "--all finds each skill's tasks file; leave out --tasks" };
  if (!all && skill === null) return { error: "missing <skill> (or --all)" };
  return { skill, tasksFile, all, checkTasks, repeat, variants, maxSteps, noApproval, json, keepWorkdir, judgeUrl, judgeModel };
}

interface EvalTarget {
  skill: string;
  taskSet: SkillEvalTaskSet;
}

/** The skills to evaluate and their task sets, or an exit-2 message. */
async function resolveTargets(parsed: SkillEvalArgs, config: AtomicAgentConfig): Promise<EvalTarget[] | { error: string }> {
  const roots = { starterDir: resolveStarterSkillsSourceDir(), globalSkillsDir: config.paths.globalSkillsDir };
  let files: Array<{ skill: string; tasksFile: string }>;
  if (parsed.all) {
    files = await listSkillsWithTasks(roots);
    if (files.length === 0) return { error: "no skill has a tasks file (evals/tasks.yaml)" };
  } else {
    const skill = parsed.skill!;
    const tasksFile = parsed.tasksFile ?? findSkillTasksFile(skill, roots);
    if (tasksFile === null) return { error: `no tasks file for ${skill}: pass --tasks <file> or add evals/tasks.yaml to the skill` };
    files = [{ skill, tasksFile }];
  }
  const targets: EvalTarget[] = [];
  for (const { skill, tasksFile } of files) {
    const taskSet = await loadTaskSet(tasksFile);
    if (taskSet.skill !== null && taskSet.skill !== skill) {
      return { error: `${taskSet.sourcePath} is written for skill "${taskSet.skill}", not "${skill}"` };
    }
    targets.push({ skill, taskSet });
  }
  return targets;
}

/**
 * `atomic-agent skill eval <skill> [--tasks tasks.yaml]` (ATO-1098): run
 * each task with the skill visible to the model and with it hidden, in a
 * fresh temp folder per run, check the answers, and save the result to
 * `<stateDir>/skill-evals/<skill>/<runId>.json`. Without `--tasks` the
 * file is found next to the skill; `--all` evaluates every skill that has
 * one, on one runtime (ATO-1163).
 *
 * The skill is hidden in memory only (`SkillRegistry.setDisabledNames`);
 * `config.json` is never written. Approval requests are refused (nobody is
 * there to answer) unless `--no-approval` is given.
 */
export async function skillEvalCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(SKILL_EVAL_USAGE);
    return 0;
  }
  const parsed = parseSkillEvalArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${SKILL_EVAL_USAGE}`);
    return 2;
  }
  // getConfig first: it loads <stateDir>/.env, where a judge key may live.
  const config = getConfig();
  const targets = await resolveTargets(parsed, config);
  if ("error" in targets) {
    process.stderr.write(`${targets.error}\n`);
    return 2;
  }
  if (parsed.checkTasks) {
    for (const t of targets) process.stdout.write(`${t.skill}\t${t.taskSet.tasks.length} tasks\t${t.taskSet.sourcePath}\n`);
    return 0;
  }
  // Picked before boot so a missing judge exits 2 before anything runs;
  // a provider judge is built once the runtime has loaded the provider.
  let judgeConfig: SkillEvalJudgeConfig | null = null;
  const judged = targets.find((t) => taskSetUsesJudge(t.taskSet));
  if (judged) {
    const picked = resolveSkillEvalJudge(parsed, config);
    if ("error" in picked) {
      process.stderr.write(`${judged.taskSet.sourcePath} has judge checks, but ${picked.error}\n`);
      return 2;
    }
    judgeConfig = picked;
  }
  const approvalLevel = resolveBootApprovalLevel(parsed.noApproval, config.agent.approvalLevel);
  const workRoot = await mkdtemp(join(tmpdir(), "atomic-skill-eval-"));
  const counters = { approvalsDenied: 0 };
  let runtime: AgentRuntime | null = null;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const rt = await createAgentRuntime({
      workingDir: workRoot,
      approvalLevel,
      traceDefault: true,
      handlers: {
        onApprovalRequest: (request) => {
          counters.approvalsDenied += 1;
          process.stderr.write(`  needs approval: ${request.tool}; denied, nobody is there to answer\n`);
          rt.approvals.resolve({
            approvalId: request.approvalId,
            approved: false,
            automatic: true,
            reason: "this is an unattended skill eval run and nobody is there to approve it",
          });
        },
      },
    });
    runtime = rt;
    // Same as `overnight`: this process runs only the eval. Its scheduler
    // would otherwise take leadership and drain unrelated due tasks under
    // the eval's approval posture.
    await rt.scheduler?.stop();
    let judge: SkillEvalJudge | null = null;
    if (judgeConfig) {
      const built = buildSkillEvalJudge(judgeConfig, rt, config);
      if ("error" in built) {
        process.stderr.write(`${judged!.taskSet.sourcePath} has judge checks, but ${built.error}\n`);
        return 2;
      }
      judge = built;
    }
    const results: SkillEvalResult[] = [];
    const missing: string[] = [];
    for (const target of targets) {
      if (controller.signal.aborted) break;
      const entry = rt.skillRegistry.listAll().find((e) => e.record.manifest.name === target.skill);
      if (!entry) {
        process.stderr.write(`skill not installed: ${target.skill}\n`);
        missing.push(target.skill);
        continue;
      }
      process.stderr.write(
        `skill eval: ${target.skill} — ${target.taskSet.tasks.length} task(s) x ${parsed.variants.join("/")} x ${parsed.repeat}\n`,
      );
      const result = await runSkillEval({
        skill: { name: target.skill, version: entry.record.manifest.version ?? null, source: entry.record.source },
        taskSet: target.taskSet,
        driver: createRuntimeSkillEvalDriver(rt, target.skill, counters),
        workRoot,
        repeat: parsed.repeat,
        variants: parsed.variants,
        maxSteps: parsed.maxSteps,
        approvalLevel,
        agentVersion: getAppVersion(),
        model: activeModel(config),
        // Only a set with judge checks gets the judge, so `judge` and
        // `judgeUsage` stay null for the others in an `--all` batch.
        judge: taskSetUsesJudge(target.taskSet) ? judge : null,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type !== "run_finished") return;
          const r = event.record;
          process.stderr.write(
            `  [${event.index + 1}/${event.total}] ${r.taskId} ${r.variant} #${r.attempt}: ${r.passed ? "pass" : "fail"} (${r.end}, ${(r.wallMs / 1000).toFixed(1)}s)\n`,
          );
        },
      });
      const path = await saveSkillEvalResult(config.paths.stateDir, result);
      process.stderr.write(`saved: ${path}\n`);
      results.push(result);
      if (!parsed.json) process.stdout.write(formatSkillEvalSummary(result));
    }
    if (parsed.json) {
      const doc = parsed.all ? { schema: SKILL_EVAL_BATCH_SCHEMA, results, missing } : results[0] ?? null;
      if (doc !== null) process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    } else if (parsed.all) {
      process.stdout.write(formatSkillEvalOverview(results, missing));
    }
    const finished = results.length + missing.length === targets.length && results.every((r) => r.complete);
    return finished && missing.length === 0 ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime?.shutdown();
    if (parsed.keepWorkdir) process.stderr.write(`work folder kept: ${workRoot}\n`);
    else await rm(workRoot, { recursive: true, force: true });
  }
}

/** `--all --json` prints one object of this schema: `{ schema, results: SkillEvalResult[], missing: string[] }`. */
export const SKILL_EVAL_BATCH_SCHEMA = "atomic-agent.skill-eval-batch/1";

/** The runtime surface the driver needs; narrow so tests can fake it. */
export type SkillEvalRuntime = Pick<AgentRuntime, "skillRegistry" | "refreshSkills" | "createSession" | "runTurn" | "sessionStore">;

/**
 * Drive a live runtime: `setVariant` hides or shows the skill in the
 * registry (in memory) and rebuilds the catalog; `runTask` runs the
 * prompt as one turn in a fresh session, then deletes that session so
 * eval runs do not pile up in the person's thread list.
 */
export function createRuntimeSkillEvalDriver(
  runtime: SkillEvalRuntime,
  skill: string,
  counters: { approvalsDenied: number },
): SkillEvalDriver {
  const baseDisabled = runtime.skillRegistry.getDisabledNames().filter((n) => n !== skill);
  return {
    async setVariant(variant) {
      runtime.skillRegistry.setDisabledNames(variant === "with" ? baseDisabled : [...baseDisabled, skill]);
      await runtime.refreshSkills();
      if (runtime.skillRegistry.has(skill) !== (variant === "with")) {
        throw new Error(`could not ${variant === "with" ? "show" : "hide"} skill ${skill} for the eval`);
      }
    },
    async runTask({ task, workingDir, signal }): Promise<SkillEvalDriverRun> {
      void workingDir; // the runtime was created on the eval's work folder
      counters.approvalsDenied = 0;
      let reply: string | null = null;
      let skillLoaded = false;
      const eventHook = (event: AgentLoopEvent): void => {
        if (event.type !== "llm_event") return;
        const inner = event.event;
        if (inner.type === "assistant_reply" && inner.progressNote !== true) reply = inner.text;
        if (inner.type === "tool_call_parsed" && inner.call.tool === "skill.view" && inner.call.args.name === skill) {
          skillLoaded = true;
        }
      };
      const session = runtime.createSession({ persist: false, metadata: { skillEval: skill } });
      try {
        const result = await runtime.runTurn(session, task.prompt, {
          ...(task.maxSteps === null ? {} : { maxSteps: task.maxSteps }),
          signal,
          origin: "cli",
          eventHook,
          // Memory is read, never written: a note, lesson or profile fact
          // one variant left behind would otherwise help the other.
          memoryReadOnly: true,
        });
        return {
          reply,
          end: result.reason,
          error: result.session.lastError ?? null,
          steps: result.stepCount,
          promptTokens: result.usage?.promptTokens ?? null,
          completionTokens: result.usage?.completionTokens ?? null,
          costUsd: result.spendUsd ?? null,
          approvalsDenied: counters.approvalsDenied,
          skillLoaded,
        };
      } finally {
        try {
          runtime.sessionStore.delete(session.id);
        } catch {
          // A session that was never saved has nothing to delete.
        }
      }
    },
  };
}

/** The judge's settings: flags and env first, then `skills.eval.judgeProvider`, then the active cloud provider. */
export function resolveSkillEvalJudge(
  parsed: Pick<SkillEvalArgs, "judgeUrl" | "judgeModel">,
  config: AtomicAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): SkillEvalJudgeConfig | { error: string } {
  return resolveJudgeConfig(
    { url: parsed.judgeUrl, model: parsed.judgeModel },
    resolveLlmConfig(config),
    config.skills.eval?.judgeProvider ?? null,
    env,
  );
}

/** The judge over the live runtime: a provider judge calls the provider the registry loaded and prices it like a turn. */
export function buildSkillEvalJudge(
  judgeConfig: SkillEvalJudgeConfig,
  runtime: Pick<AgentRuntime, "providerRegistry">,
  config: AtomicAgentConfig,
): SkillEvalJudge | { error: string } {
  if (judgeConfig.kind === "http") return createSkillEvalJudge(judgeConfig);
  const provider = runtime.providerRegistry.getProvider(judgeConfig.providerId);
  if (!provider) return { error: `the judge provider "${judgeConfig.providerId}" did not load` };
  const llm = resolveLlmConfig(config);
  return createSkillEvalJudge(judgeConfig, {
    provider,
    priceUsage: (usage, modelId) => {
      const pricing = resolveModelPricingFor(llm, modelId, judgeConfig.providerId)?.pricing;
      return pricing ? estimateUsageCostUsd(usage, pricing) : null;
    },
  });
}

function activeModel(config: AtomicAgentConfig): { provider: string | null; model: string | null } {
  const llm = resolveLlmConfig(config);
  const entry = llm.providers.find((p) => p.id === llm.activeTextProvider);
  return {
    provider: llm.activeTextProvider,
    model: entry?.defaultChatModel ?? entry?.model ?? config.localModels.managed.modelId ?? null,
  };
}
