import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import { DEFAULT_FUSION_CLOUD_WORKERS } from "../../config/llm-run-mode-config.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { StructuredLogger } from "../../tracing/index.js";
import {
  builtinAgentProfileSet,
  type AgentProfileSet,
} from "../../agent-profiles/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { DelegateTask } from "../fusion/delegate-args.js";
import {
  allowedModels,
  resolveTaskLegs,
  type TaskLeg,
  type WorkerLegRef,
} from "../fusion/role-models.js";
import {
  applyTaskProfiles,
  type AppliedProfileReport,
} from "../fusion/task-profiles.js";
import { treeLimitBreach } from "../fusion/task-tree.js";
import { runWorkerTasksCore } from "../fusion/worker-runner.js";
import type { WorkerRunnerCoreDeps } from "../fusion/worker-runner-core.js";
import {
  delegateOutcome,
  formatDelegateOutput,
  type WorkerTaskResult,
} from "../fusion/worker-result.js";
import { parseSubagentArgs } from "./subagent-args.js";
import {
  SUBAGENT_MAX_CHILDREN_PER_TURN,
  SUBAGENT_MAX_DEPTH,
  SubagentTurnLedger,
  callerDepth,
} from "./subagent-limits.js";

export const SUBAGENT_RUN_TOOL = "subagent.run";

export interface SubagentRunDeps extends WorkerRunnerCoreDeps {
  /** Live read: in Fusion the tool refuses and points at `fusion.delegate`. */
  resolveRunMode: () => ResolvedRunMode;
  /**
   * The provider and model the calling session runs on: the step's
   * pinned provider when it has one, else the active text provider, with
   * its configured chat model as the label. A subagent runs there unless
   * its profile's model resolves to a configured role.
   */
  resolveSessionLeg: (pinnedProviderId: string | undefined) => WorkerLegRef;
  /** A slot-affine (local) leg runs one subagent at a time. */
  workerSupportsSlotAffinity: (providerId: string) => boolean;
  /**
   * The calling session's metadata, where its depth stamp lives. Absent,
   * or no answer for the id: depth 0, except that a worker id is always
   * at least depth 1 (`callerDepth`).
   */
  readSessionMetadata?: (sessionId: string) => Record<string, unknown> | undefined;
  /** The same profile loader `fusion.delegate` takes. Absent: the built-ins. */
  resolveAgentProfiles?: (workingDir: string) => AgentProfileSet;
  /** The operator's request behind the turn, quoted into every brief. */
  resolveOriginalRequest?: (sessionId: string) => string | undefined;
  /** Budget for the rendered result block. */
  outputCharCap: number;
  logger?: Pick<StructuredLogger, "info" | "warn">;
  /** Per-turn child counts. Absent: the tool keeps its own. */
  turnLedger?: SubagentTurnLedger;
}

function error(
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({
    tool: SUBAGENT_RUN_TOOL,
    status: "error",
    output,
    details,
  });
}

/**
 * `subagent.run` (ATO-1670): hand self-contained parts of the work to
 * subagents, each a worker turn on the shared runner core, outside
 * Fusion.
 *
 * Refusals, in order, all before any work starts:
 *
 *  1. **Not from a subagent or a worker.** The caller's depth comes from
 *     its session data (`callerDepth`, failing closed on a worker id),
 *     checked against `SUBAGENT_MAX_DEPTH` with the task tree's own
 *     check. Hiding the tool from workers (`WORKER_EXCLUDED_TOOLS`) only
 *     keeps it out of their catalog; this is what forbids it.
 *  2. **Not in Fusion.** There the orchestrator hands work out with
 *     `fusion.delegate`, which takes the same profiles.
 *  3. **Only on valid args,** at most `SUBAGENT_MAX_CHILDREN_PER_CALL`
 *     tasks, and at most `SUBAGENT_MAX_CHILDREN_PER_TURN` across the
 *     turn (the task tree's node check again).
 *  4. **Only known profiles.** `applyTaskProfiles`, as in Fusion.
 *
 * Each subagent's session is stamped one level below its caller, its
 * turn runs under the `subagent` origin with the worker tool policy and
 * the profile's allowlist on top, and an approval-gated step is refused
 * by the worker session policy, as for every worker.
 */
export function buildSubagentRunTool(deps: SubagentRunDeps): ToolDefinition {
  const ledger = deps.turnLedger ?? new SubagentTurnLedger();
  return {
    name: SUBAGENT_RUN_TOOL,
    description:
      "Hand self-contained parts of the work to subagents: each task becomes a fresh worker turn on the current model that sees the user's request and its own instructions, and reports back. A task may name a `profile` (built-in: explore, review, research, all read-only; or one the user defined) for that profile's instructions and tool list. A subagent cannot start subagents. Args: { tasks: [{ id, instructions, title?, profile?, deliverable? }] }.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      const depth = callerDepth(
        ctx.sessionId,
        deps.readSessionMetadata?.(ctx.sessionId),
      );
      const tooDeep = treeLimitBreach({
        depth,
        maxDepth: SUBAGENT_MAX_DEPTH,
        nodes: 0,
        maxNodes: SUBAGENT_MAX_CHILDREN_PER_TURN,
        adding: 0,
      });
      if (tooDeep?.kind === "depth") {
        return error(
          `${SUBAGENT_RUN_TOOL} is not available to a subagent or a worker: do the task you were given yourself and report back in your reply.`,
          { reason: "depth", depth, maxDepth: SUBAGENT_MAX_DEPTH },
        );
      }
      const mode = deps.resolveRunMode();
      if (mode.effective === "fusion") {
        return error(
          `${SUBAGENT_RUN_TOOL} is not used in Fusion mode: hand the parts out with fusion.delegate, which takes the same \`profile\`.`,
          { reason: "fusion" },
        );
      }
      const parsed = parseSubagentArgs(rawArgs);
      if (!parsed.ok) {
        return error(`${SUBAGENT_RUN_TOOL}: ${parsed.error}`, { field: "tasks" });
      }
      const already = ledger.childrenThisTurn(ctx.sessionId, ctx.stepIndex);
      const overTurn = treeLimitBreach({
        depth,
        maxDepth: SUBAGENT_MAX_DEPTH,
        nodes: already,
        maxNodes: SUBAGENT_MAX_CHILDREN_PER_TURN,
        adding: parsed.tasks.length,
      });
      if (overTurn?.kind === "nodes") {
        return error(
          `${SUBAGENT_RUN_TOOL} did not run: ${parsed.tasks.length} more subagent${parsed.tasks.length === 1 ? "" : "s"} would make ${overTurn.total} this turn, over the limit of ${overTurn.maxNodes} (${already} already ran). Finish the rest yourself.`,
          {
            reason: "children-per-turn",
            already,
            maxChildrenPerTurn: overTurn.maxNodes,
          },
        );
      }

      const sessionLeg = deps.resolveSessionLeg(ctx.providerId);
      let tasks: DelegateTask[] = parsed.tasks;
      let profileReports: AppliedProfileReport[] = [];
      if (tasks.some((t) => t.profile !== undefined)) {
        let profiles: AgentProfileSet;
        try {
          profiles =
            deps.resolveAgentProfiles?.(ctx.workingDir) ??
            builtinAgentProfileSet();
        } catch (err) {
          deps.logger?.warn("subagent: loading agent profiles failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          profiles = builtinAgentProfileSet();
        }
        if (profiles.diagnostics.length > 0) {
          deps.logger?.warn("subagent: agent profile problems", {
            diagnostics: profiles.diagnostics,
          });
        }
        const profiled = applyTaskProfiles(
          tasks,
          profiles,
          allowedModels(sessionLeg, mode.roles),
        );
        if (!profiled.ok) {
          return error(`${SUBAGENT_RUN_TOOL}: ${profiled.error}`, {
            field: "tasks",
            reason: "unknown-profile",
          });
        }
        tasks = profiled.tasks;
        profileReports = profiled.applied;
      }

      // Where each task runs: the session's leg, or the role model its
      // profile names when `llm.runMode.fusion.roles` configures one,
      // resolved exactly as `fusion.delegate` resolves it.
      const legs = resolveTaskLegs(tasks, sessionLeg, mode.roles);
      const groups = new Map<string, { leg: TaskLeg; tasks: DelegateTask[] }>();
      for (const task of tasks) {
        const leg = legs.get(task.id)!;
        const key = `${leg.providerId}\u0000${leg.turnModel ?? ""}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, { leg, tasks: [task] });
        else group.tasks.push(task);
      }

      ledger.record(ctx.sessionId, ctx.stepIndex, tasks.length);
      const childDepth = depth + 1;
      const originalRequest = deps.resolveOriginalRequest?.(ctx.sessionId);
      const runnerDeps: WorkerRunnerCoreDeps = {
        ...deps,
        workingDir: ctx.workingDir,
        ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}),
      };
      const runGroup = async (group: {
        leg: TaskLeg;
        tasks: DelegateTask[];
      }): Promise<WorkerTaskResult[]> => {
        // One at a time on a local server, as Fusion runs a fan-out that
        // named no width; a cloud leg takes the cloud worker cap.
        const local = deps.workerSupportsSlotAffinity(group.leg.providerId);
        const maxWorkers = local
          ? 1
          : Math.max(
              1,
              Math.min(
                group.tasks.length,
                mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS,
              ),
            );
        return runWorkerTasksCore(runnerDeps, {
          parentSessionId: ctx.sessionId,
          tasks: group.tasks,
          maxWorkers,
          providerId: group.leg.providerId,
          workerModel: group.leg.model,
          ...(group.leg.turnModel === undefined
            ? {}
            : { turnModel: group.leg.turnModel }),
          workerMaxSteps: mode.workerMaxSteps,
          workerTimeoutMs: mode.workerTimeoutMs,
          ...(mode.workerReasoning === undefined
            ? {}
            : { workerReasoning: mode.workerReasoning }),
          ...(mode.workerMaxOutputTokens === undefined
            ? {}
            : { workerMaxOutputTokens: mode.workerMaxOutputTokens }),
          ...(originalRequest === undefined ? {} : { originalRequest }),
          signal: ctx.signal,
          origin: "subagent",
          depth: childDepth,
        });
      };

      let byId: Map<string, WorkerTaskResult>;
      try {
        const settled = await Promise.all([...groups.values()].map(runGroup));
        byId = new Map(settled.flat().map((r) => [r.id, r]));
      } catch (err) {
        // The runner is written not to throw; if it ever does, say so
        // rather than take the caller's turn down.
        return error(
          `${SUBAGENT_RUN_TOOL} failed: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "runner-threw" },
        );
      }
      const results = tasks.map((task) => {
        const row = byId.get(task.id)!;
        const leg = legs.get(task.id)!;
        const notes = [
          ...(leg.note === undefined ? [] : [leg.note]),
          ...(leg.isWorkerLeg
            ? []
            : [
                `ran on ${leg.model}${leg.role === undefined ? "" : ` (role ${leg.role})`}`,
              ]),
        ];
        return {
          ...row,
          model: leg.model,
          ...(leg.role === undefined ? {} : { modelRole: leg.role }),
          ...(notes.length === 0 ? {} : { notes: [...(row.notes ?? []), ...notes] }),
        };
      });
      const outcome = delegateOutcome(results);
      return compressToolResult(
        {
          tool: SUBAGENT_RUN_TOOL,
          status: outcome === "all_failed" ? "error" : "ok",
          output: formatDelegateOutput(results, deps.outputCharCap),
          details: {
            tasks: results,
            outcome,
            depth: childDepth,
            origin: "subagent",
            ...(profileReports.length === 0 ? {} : { profiles: profileReports }),
          },
        },
        { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
      );
    },
  };
}
