import type { ApprovalGate } from "../../approval/approval-gate.js";
import { requireApproval } from "../../approval/dangerous-tool.js";
import { resolveFanoutScope } from "./fanout-paths.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/index.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import { DEFAULT_FUSION_CLOUD_WORKERS } from "../../config/llm-run-mode-config.js";
import type { ToolDefinition } from "../tool-registry.js";
import { parseDelegateArgs } from "./delegate-args.js";
import {
  applyCheckOutcomes,
  applyContractFindings,
  inspectContractProvides,
  renderContractLine,
  runContractChecks,
  type ContractCheckRunner,
  type ContractReport,
} from "./contract-checks.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  delegateOutcome,
  fanoutSpend,
  formatDelegateOutput,
  type WorkerPricing,
  type WorkerTaskResult,
} from "./worker-result.js";

export const FUSION_DELEGATE_TOOL = "fusion.delegate";

export interface FusionDelegateDeps extends WorkerRunnerDeps {
  /**
   * Whether the fan-out asks the operator before it runs. Same seam as
   * every other dangerous tool: production passes `true`, tests pass
   * `false` to exercise the fan-out without a gate.
   */
  approvalRequired: boolean;
  slotManager: Pick<SlotManager, "poolSize">;
  /** Live read — the operator can leave fusion mid-turn. */
  resolveRunMode: () => ResolvedRunMode;
  /** Does the worker leg keep KV-cache affinity per slot? */
  workerSupportsSlotAffinity: (providerId: string) => boolean;
  /** The fallback seam's `prepareLink`: warm the local backend once. */
  warmWorkerBackend: (providerId: string) => Promise<void>;
  /** Budget for the rendered result block. */
  outputCharCap: number;
  logger: StructuredLogger;
  /**
   * The operator's request behind the turn now running on `sessionId`
   * (the orchestrator's session), quoted into every worker brief. The
   * runtime records it when the turn starts; absent, the briefs carry
   * only the orchestrator's instructions, as they did before.
   */
  resolveOriginalRequest?: (sessionId: string) => string | undefined;
  /**
   * Runs a contract's `checks` (`verify.run` specs) after the fan-out —
   * the verify tool family's `runChecks`, wired by the runtime. Absent,
   * declared checks are reported as not run; they are never assumed to
   * have passed.
   */
  runChecks?: ContractCheckRunner;
  /**
   * Pricing for the worker model on the worker leg, when any is known
   * (`resolveModelPricingFor`). Present, the status table header states
   * the fan-out's spend; a local leg resolves to nothing.
   */
  resolveWorkerPricing?: (
    providerId: string,
    modelId: string,
  ) => WorkerPricing | undefined;
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), read per fan-out so a
   * worker's time limit follows the machine's current load. Only
   * consulted for a slot-affine (local) leg; `null` before any
   * completion has been measured.
   */
  localTokensPerSecond?: () => number | null;
}

function error(
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({
    tool: FUSION_DELEGATE_TOOL,
    status: "error",
    output,
    details,
  });
}

/**
 * `fusion.delegate` — the orchestrator's fan-out.
 *
 * In fusion mode the active (cloud) model plans and this tool spends
 * the local ones: each task becomes an ephemeral worker session running
 * a turn pinned to the llama-server leg, several at a time, and the
 * orchestrator gets every reply back in one result. Cloud tokens pay
 * for the thinking, local tokens for the bulk.
 *
 * Three refusals, in order, all before any work starts:
 *
 *  1. **Not from inside a worker.** One level of fan-out keeps the cost
 *     model legible and the process bounded. `worker-tool-policy.ts`
 *     already hides the descriptor from a worker's catalog; this is the
 *     hard stop for a model that emits the name anyway.
 *  2. **Only while fusion is effective.** The mode is re-read live, not
 *     captured at boot: an operator who switches the active provider in
 *     Manage → LLM leaves fusion on the next read (§"Run modes"), and a
 *     tool that kept fanning out would be spending on a leg the operator
 *     just walked away from.
 *  3. **Only on valid args.** See `parseDelegateArgs`: the refusal
 *     names every problem of the call at once, so a slow local
 *     orchestrator regenerates once, not once per field.
 *
 * Once the call runs, its status summarises its tasks
 * (`details.outcome`): `ok` while any task delivered anything — partial
 * results are the whole value of a fan-out, and an orchestrator handed
 * a bare error learns nothing about which parts survived — and `error`
 * only when every task failed or was cancelled. Per-task status lives
 * in the output and in `details.tasks` either way.
 *
 * **Width is the model's call.** `args.maxWorkers` is honoured as asked;
 * `llm.runMode.fusion.workers` only fills in for a call that named
 * nothing. The orchestrator is the one that knows how divisible this
 * particular job is, and the `### fusion` guidance block tells it what
 * the machine can serve, so an operator-set number in a config file is
 * the wrong place to decide. The bounds that remain are physical: the
 * task count, and the server's request slots on a slot-affine leg.
 */
/**
 * What the operator reads before authorising a fan-out.
 *
 * The task titles, not a count: one prompt stands in for every write
 * these workers make, so the thing being approved has to be legible as
 * work, not as a number. The scope is stated last because it is the part
 * the answer actually grants.
 */
export function describeFanoutPreview(
  tasks: readonly { title: string }[],
  writeScope: readonly string[],
): string {
  const lines = tasks.map((task) => `  • ${task.title}`);
  const scope =
    writeScope.length > 0
      ? [
          `may write files and run commands in:`,
          ...writeScope.map((dir) => `  ${dir}`),
        ]
      : [
          `no writable directory could be derived from the briefs, so the`,
          `workers will still have to hand every write back up.`,
        ];
  return [...lines, "", ...scope].join("\n");
}

export function buildFusionDelegateTool(
  deps: FusionDelegateDeps,
): ToolDefinition {
  return {
    name: FUSION_DELEGATE_TOOL,
    description:
      "Delegate independent parts of the work to local worker agents that run concurrently. You choose how many run at once with `maxWorkers`. An optional `contract` (owners, provides, requires, checks) is prepended to every brief and checked after the fan-out. Args: { tasks: [{ id, instructions, title?, deliverable?, files? }], maxWorkers?, contract? }.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      if (isFusionWorkerSessionId(ctx.sessionId)) {
        return error(
          "fusion.delegate is not available to a worker: do the task you were given and report back in your reply.",
          { reason: "recursive-delegation" },
        );
      }
      const mode = deps.resolveRunMode();
      const workerProviderId = mode.workerProviderId;
      if (mode.effective !== "fusion" || workerProviderId === null) {
        return error(
          `fusion.delegate needs run mode "fusion" with a local worker provider; the run mode is "${mode.effective}". Do the work yourself.`,
          { reason: "not-fusion", effective: mode.effective },
        );
      }
      const parsed = parseDelegateArgs(rawArgs);
      if (!parsed.ok) return error(parsed.error, { field: "tasks" });

      // Before the pool is measured: warming replays the probes a cloud
      // boot deferred, and it is the `/props` round trip inside it that
      // resizes the slot pool from 1 to the daemon's real `--parallel`.
      // Reading `poolSize()` first would cap every fan-out at one worker
      // on a freshly booted cloud-active runtime.
      try {
        await deps.warmWorkerBackend(workerProviderId);
      } catch (err) {
        // Non-fatal: the completion itself will fail loudly a moment
        // later if the backend is really down, and that failure lands on
        // the task row instead of taking the whole call with it.
        deps.logger.warn("fusion: warming the worker backend failed", {
          providerId: workerProviderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const slotAffine = deps.workerSupportsSlotAffinity(workerProviderId);
      const poolSize = slotAffine
        ? Math.max(1, deps.slotManager.poolSize())
        : Number.POSITIVE_INFINITY;
      // The ORCHESTRATOR decides the width. It is the party that knows
      // what this fan-out is made of, and the `### fusion` block tells
      // it what the machine can serve, so `runMode.workers` is only the
      // default for a call that named nothing — never a ceiling on a
      // larger number the model asked for. What is left bounding it is
      // physical: you cannot run more workers than there are tasks, and
      // on a slot-affine leg you cannot run more than the server has
      // request slots (the rest would queue and evict each other's KV
      // cache rather than run).
      // A call that named no width on a LOCAL leg runs one worker at a
      // time unless the operator pinned `runMode.fusion.workers`: the
      // slots share one GPU, and the benchmark measured two local
      // workers at 2.6-2.9 tok/s each against 6.4 for one — parallel is
      // not faster there until a measurement says so, while a fan-out
      // that overflows the shared context loses every worker at once.
      // A cloud leg has no such pool and takes the configured default.
      const requested =
        parsed.maxWorkers ??
        (slotAffine ? (mode.workersPinned ? mode.workers : 1) : mode.workers);
      const wanted = Math.max(1, Math.min(requested, parsed.tasks.length));
      // A cloud leg has no slot pool, so nothing physical bounds the
      // width — only the bill. `cloudWorkers` is that bound: a
      // `maxWorkers` above it is clamped, and the result says so, since
      // the orchestrator is the party that can re-plan around it.
      const cloudCap = Number.isFinite(poolSize)
        ? Number.POSITIVE_INFINITY
        : (mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS);
      const maxWorkers = Math.max(1, Math.min(wanted, poolSize, cloudCap));
      const cloudCapIsBinding = maxWorkers < wanted && maxWorkers === cloudCap;
      // The pool held this fan-out down when it ran fewer at a time than
      // there was work for — whether the orchestrator asked for a wider
      // number or simply had more tasks than the machine has slots.
      const poolIsBinding =
        !cloudCapIsBinding &&
        (maxWorkers < wanted || maxWorkers < parsed.tasks.length);

      // Labels, never guesses: the resolver's pin when it has one, the
      // provider id when it does not. Both legs are read from the same
      // live `mode` the fan-out is about to run on.
      const workerModel = mode.workerModel ?? workerProviderId;
      const orchestratorModel =
        mode.orchestratorModel ??
        mode.orchestratorProviderId ??
        mode.primaryProviderId;

      // The orchestrator claims its own call before the workers start
      // talking. Everything between this line and the closing one below
      // is worker work on the local leg; this is the runtime's only
      // honest, zero-cost place to say so — the parent turn's other
      // steps are served through the fallback chain and may not have run
      // on `orchestratorModel` at all, so they are deliberately left
      // unlabelled rather than attributed on a guess.
      deps.emitEvent(ctx.sessionId, {
        type: "fusion_worker",
        taskId: FUSION_DELEGATE_TOOL,
        title: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}`,
        phase: "tool",
        role: "orchestrator",
        model: orchestratorModel,
        tool: FUSION_DELEGATE_TOOL,
      });

      // One question for the whole fan-out, asked before a single worker
      // starts. A worker has no operator to ask — that is what made the
      // mode unusable below full trust, with every write refused and the
      // orchestrator left as the only party able to act — so the
      // operator is asked here instead, once, with the task list and the
      // directory in front of them.
      const writeScope = resolveFanoutScope(parsed.tasks, ctx.workingDir);
      // A turn is one job. An orchestrator that reviews and re-delegates
      // runs five fan-outs to build one library, and asking the same
      // question five times is attrition, not consent. The operator's
      // answer stands for the rest of the turn as long as later fan-outs
      // stay inside the directories it named; one reaching somewhere new
      // asks again.
      const alreadyApproved =
        deps.approvals.fanoutScopes?.turnGrantCovers(
          ctx.sessionId,
          writeScope,
        ) ?? false;
      try {
        if (!alreadyApproved)
          await requireApproval(
            {
              approvals: deps.approvals as ApprovalGate,
              approvalRequired: deps.approvalRequired,
            },
            {
              sessionId: ctx.sessionId,
              tool: FUSION_DELEGATE_TOOL,
              category: "fusion_fanout",
              reason: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"} to ${maxWorkers} worker${maxWorkers === 1 ? "" : "s"} on ${workerModel}`,
              preview: describeFanoutPreview(parsed.tasks, writeScope),
              affectedResources: [...writeScope],
            },
            ctx.signal,
          );
        deps.approvals.fanoutScopes?.grantForTurn(ctx.sessionId, writeScope);
      } catch (err) {
        return error(
          `the fan-out was not approved: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "fan-out-denied" },
        );
      }

      // The orchestrator's brief is a summary, and summaries were thin
      // enough that workers built the wrong thing or scavenged the disk
      // for the missing spec. Every worker also gets what was asked.
      const originalRequest = deps.resolveOriginalRequest?.(ctx.sessionId);
      // A local worker's time limit is sized from the machine's measured
      // speed (F19); a cloud leg has no such measurement and keeps the
      // configured ceiling.
      const localTokensPerSecond = Number.isFinite(poolSize)
        ? (deps.localTokensPerSecond?.() ?? null)
        : null;

      let results: WorkerTaskResult[];
      try {
        results = await runWorkerTasks(deps, {
          ...(originalRequest === undefined ? {} : { originalRequest }),
          ...(parsed.contract === undefined ? {} : { contract: parsed.contract }),
          parentSessionId: ctx.sessionId,
          tasks: parsed.tasks,
          maxWorkers,
          providerId: workerProviderId,
          workerModel,
          workerMaxSteps: mode.workerMaxSteps,
          workerTimeoutMs: mode.workerTimeoutMs,
          localTokensPerSecond,
          ...(mode.workerReasoning === undefined
            ? {}
            : { workerReasoning: mode.workerReasoning }),
          ...(mode.workerMaxOutputTokens === undefined
            ? {}
            : { workerMaxOutputTokens: mode.workerMaxOutputTokens }),
          writeScope,
          signal: ctx.signal,
        });
      } catch (err) {
        // `runWorkerTasks` is written not to throw; if it ever does, the
        // orchestrator still gets a readable result rather than a dead turn.
        return error(
          `the fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "fan-out-failed" },
        );
      }

      // The contract's verdict, from the disk and the check runner, folded
      // into the rows BEFORE the head line counts them: a task whose
      // declared check failed is `failed` in the table the orchestrator
      // reads, not `ok` with a footnote.
      let contract: ContractReport | undefined;
      if (parsed.contract !== undefined) {
        const findings = await inspectContractProvides(
          parsed.contract,
          parsed.tasks,
          ctx.workingDir,
        );
        results = applyContractFindings(results, findings);
        const checks = await runContractChecks(
          parsed.contract.checks ?? [],
          deps.runChecks,
          { workingDir: ctx.workingDir, signal: ctx.signal },
        );
        results = applyCheckOutcomes(results, checks.outcomes);
        // What the call was run with despite the contract — a require
        // nobody provides, a provide nothing can check. The workers read
        // it in their block; the orchestrator reads it here, on the line
        // and in the details.
        const warnings = parsed.contract.warnings ?? [];
        contract = {
          findings,
          checks: checks.outcomes,
          ...(checks.checksSkipped === undefined
            ? {}
            : { checksSkipped: checks.checksSkipped }),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }
      const contractLine =
        contract === undefined ? undefined : renderContractLine(contract);

      // …and takes the turn back. One line, so the operator can see the
      // spend return to the cloud leg instead of guessing which of the
      // lines above was the last worker.
      const okCount = results.filter((r) => r.status === "ok").length;
      deps.emitEvent(ctx.sessionId, {
        type: "fusion_worker",
        taskId: FUSION_DELEGATE_TOOL,
        title: `${results.length} task${results.length === 1 ? "" : "s"}`,
        phase: "finished",
        role: "orchestrator",
        model: orchestratorModel,
        summary: `${okCount}/${results.length} ok — merging`,
      });

      // When the pool is what held the fan-out down, the orchestrator is
      // the party that can adapt — by splitting differently next time,
      // or by telling the operator which knob to turn. So the note names
      // all three things it needs: what was wanted, what actually ran
      // concurrently, and the config key that changes the second number.
      const hint = poolIsBinding
        ? `\n\nNote: ${Math.max(wanted, parsed.tasks.length)} workers' worth of work was sent but the local server has ${poolSize} request slot${poolSize === 1 ? "" : "s"}, so only ${maxWorkers} ran at a time and the rest queued. That number comes from the machine — every slot draws on one shared llama-server context pool (\`localModels.managed.parallel\`, \`"auto"\` by default). Split into fewer, larger tasks if the queueing is costing more than the parallelism buys.`
        : cloudCapIsBinding
          ? `\n\nNote: maxWorkers ${wanted} was clamped to ${maxWorkers}, the cloud worker cap (\`llm.runMode.fusion.cloudWorkers\`); the rest queued behind them.`
          : "";
      // The call's own status is the tasks' summary: a fan-out where
      // every worker failed used to come back `ok`, and an orchestrator
      // reading only the status merged nothing as if it were something.
      const outcome = delegateOutcome(results);
      // What the fan-out cost on the worker leg, when its model is priced
      // (a cloud leg with a catalogue entry); a local leg resolves to no
      // pricing and the header says nothing.
      const pricing = deps.resolveWorkerPricing?.(workerProviderId, workerModel);
      const spend =
        pricing === undefined ? null : fanoutSpend(results, pricing, workerModel);
      return compressToolResult(
        {
          tool: FUSION_DELEGATE_TOOL,
          status: outcome === "all_failed" ? "error" : "ok",
          output: `${formatDelegateOutput(results, deps.outputCharCap, {
            ...(contractLine === undefined ? {} : { contractLine }),
            spend,
          })}${hint}`,
          details: {
            tasks: results,
            outcome,
            maxWorkers,
            requestedWorkers: requested,
            ...(Number.isFinite(poolSize) ? { slotPoolSize: poolSize } : {}),
            ...(contract === undefined ? {} : { contract }),
            ...(spend === null ? {} : { workerSpendUsd: spend.usd }),
          },
        },
        { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
      );
    },
  };
}
