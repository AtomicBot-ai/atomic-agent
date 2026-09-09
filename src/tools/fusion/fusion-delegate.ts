import { compressToolResult } from "../../compressor/result-compressor.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/index.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import type { ToolDefinition } from "../tool-registry.js";
import { parseDelegateArgs } from "./delegate-args.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import { formatDelegateOutput, type WorkerTaskResult } from "./worker-result.js";

export const FUSION_DELEGATE_TOOL = "fusion.delegate";

export interface FusionDelegateDeps extends WorkerRunnerDeps {
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
}

function error(output: string, details: Record<string, unknown> = {}): CompressedToolResult {
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
 *  3. **Only on valid args.** See `parseDelegateArgs`.
 *
 * Once the call runs it returns `status: "ok"` even when every worker
 * failed. Per-task status lives in the output and in
 * `details.tasks` — an orchestrator that gets a bare error learns
 * nothing about which parts survived, and partial results are the whole
 * value of a fan-out.
 */
export function buildFusionDelegateTool(deps: FusionDelegateDeps): ToolDefinition {
  return {
    name: FUSION_DELEGATE_TOOL,
    description:
      "Delegate independent parts of the work to local worker agents that run concurrently. Args: { tasks: [{ id, title, instructions, deliverable?, files? }], maxWorkers? }.",
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

      const poolSize = deps.workerSupportsSlotAffinity(workerProviderId)
        ? Math.max(1, deps.slotManager.poolSize())
        : Number.POSITIVE_INFINITY;
      const maxWorkers = Math.max(
        1,
        Math.min(
          parsed.maxWorkers ?? mode.workers,
          parsed.tasks.length,
          poolSize,
        ),
      );

      let results: WorkerTaskResult[];
      try {
        results = await runWorkerTasks(deps, {
          parentSessionId: ctx.sessionId,
          tasks: parsed.tasks,
          maxWorkers,
          providerId: workerProviderId,
          workerMaxSteps: mode.workerMaxSteps,
          workerTimeoutMs: mode.workerTimeoutMs,
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

      const hint =
        poolSize === 1 && parsed.tasks.length > 1
          ? `\n\nNote: the local server has one slot, so these ran one at a time — raise \`localModels.managed.parallel\` for real concurrency.`
          : "";
      return compressToolResult(
        {
          tool: FUSION_DELEGATE_TOOL,
          status: "ok",
          output: `${formatDelegateOutput(results, deps.outputCharCap)}${hint}`,
          details: { tasks: results, maxWorkers },
        },
        { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
      );
    },
  };
}
