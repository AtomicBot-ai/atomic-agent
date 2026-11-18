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
import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  ApprovalDeniedError,
  requireApproval,
} from "../../approval/dangerous-tool.js";
import type { ToolDefinition } from "../tool-registry.js";
import { costCeilingReached } from "../../agent/turn/turn-spend.js";
import { estimateUsageCostUsd, formatUsd } from "../../llm/provider/usage-cost.js";
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
import { resolveFanoutScope } from "../fusion/fanout-paths.js";
import {
  describeFanoutPreview,
  scopeInsideStateDir,
} from "../fusion/fusion-delegate.js";
import {
  FUSION_WORKER_APPROVAL_MARKER,
  FUSION_WORKER_OPERATOR_ONLY_MARKER,
  workerRefusalFor,
} from "../fusion/worker-tool-policy.js";
import { runWorkerTasksCore } from "../fusion/worker-runner.js";
import type { WorkerRunnerCoreDeps } from "../fusion/worker-runner-core.js";
import {
  delegateOutcome,
  formatDelegateOutput,
  type WorkerPricing,
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

/**
 * What a subagent's approval prompt is refused with: a subagent has no
 * one to ask, and its caller is the session that called the tool, not a
 * Fusion orchestrator. Keeps `FUSION_WORKER_APPROVAL_MARKER`, so the row
 * still comes back `needs_orchestrator` and the brief's wording holds.
 */
export const SUBAGENT_APPROVAL_REFUSED =
  `this step ${FUSION_WORKER_APPROVAL_MARKER}. ` +
  `It is outside the files this ${SUBAGENT_RUN_TOOL} call was approved for. Stop and, in your reply, ` +
  `name the exact path, so the caller can call ${SUBAGENT_RUN_TOOL} again with that path in the task's \`files\` ` +
  "or make the change itself. " +
  "A browser step that submits, publishes, deletes, pays or enters a password needs the user: " +
  "report that step and do not retry it another way.";

/**
 * The refusal for a step no declared file can authorise (the same
 * categories as `workerRefusalFor`): naming the path would only loop.
 */
export const SUBAGENT_OPERATOR_ONLY_REFUSED =
  `this step ${FUSION_WORKER_APPROVAL_MARKER}, and ${FUSION_WORKER_OPERATOR_ONLY_MARKER}: ` +
  "a dangerous command (rm -rf, git reset --hard, a force push, sudo), a read or change of " +
  "the agent's own config or secret files, a mail, a password or a payment. " +
  "Do not retry it or try another way to do the same thing. In your reply, name the exact " +
  "command or file: running the task again will not help, only the user can run or approve it.";

/**
 * Why a subagent did not start or was stopped: the agent turn's spend
 * ceiling (`ToolContext.turnSpend`) is reached, its own spend and its
 * subagents' together. Rows carry it the way Fusion's carry its turn
 * cap: `not started: ...` on a task that never ran, and
 * `stopped by the turn's cap: ...` on one cut short.
 */
export function subagentCeilingMessage(spentUsd: number, ceilingUsd: number): string {
  return `the spend budget for this task is reached: ${formatUsd(spentUsd)} spent of the ${formatUsd(ceilingUsd)} allowed`;
}

/** `SessionApprovalPolicy.reasonFor` for a subagent. */
export function subagentRefusalFor(request: {
  category: Parameters<typeof workerRefusalFor>[0]["category"];
}): string | undefined {
  return workerRefusalFor(request) === undefined
    ? undefined
    : SUBAGENT_OPERATOR_ONLY_REFUSED;
}

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
  /**
   * Whether approvals are asked at all (`dangerous.approvalRequired`).
   * When a task declares `files`, the person is asked once per call,
   * under the same `fusion_fanout` category `fusion.delegate` uses, and
   * a yes lets the subagents write inside those directories.
   */
  approvalRequired: boolean;
  /** The agent's own state directory: a declared file may not be in it. */
  agentStateDir?: string;
  /**
   * A leg's price, the resolver `fusion.delegate` is given. Under a spend
   * ceiling each subagent completion is priced with it and added to the
   * turn's spend; no price (a local leg) counts as $0, as in Fusion.
   */
  resolveWorkerPricing?: (providerId: string, modelId: string) => WorkerPricing | undefined;
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
 * by the worker session policy, as for every worker, with a refusal
 * that tells the subagent to name the path for its caller.
 *
 * A subagent may write only where a task declared `files`: the person
 * is asked once for the call, as for a Fusion fan-out
 * (`resolveFanoutScope`, `describeFanoutPreview`, category
 * `fusion_fanout`), and a yes is granted to every subagent of the call.
 */
export function buildSubagentRunTool(deps: SubagentRunDeps): ToolDefinition {
  const ledger = deps.turnLedger ?? new SubagentTurnLedger();
  // The turn each session's standing write answer was given in. The
  // gate's turn grant is keyed by session only and is cleared at turn
  // start only for a Fusion turn, so outside Fusion this tool drops a
  // grant from any other turn itself before reading it.
  const grantTurns = new Map<string, string>();
  return {
    name: SUBAGENT_RUN_TOOL,
    description:
      "Hand self-contained parts of the work to subagents: each task becomes a fresh worker turn on the current model that sees the user's request and its own instructions, and reports back. A task may name a `profile` (built-in: explore, review, research, all read-only; or one the user defined) for that profile's instructions and tool list. A task that lists `files` lets its subagent write in the directories of those files and in the working directory, after one question to the user for the call; without `files` a subagent cannot write, so make the edit yourself. A subagent cannot start subagents. Args: { tasks: [{ id, instructions, title?, profile?, deliverable?, files? }] }.",
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
      const turnAt = {
        stepIndex: ctx.stepIndex,
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
      };
      const already = ledger.childrenThisTurn(ctx.sessionId, turnAt);
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

      // The turn's own model when it asked its link for one (the
      // desktop's per-project model, ATO-1148): the subagents ask for it
      // too, and their rows name it.
      const baseLeg = deps.resolveSessionLeg(ctx.providerId);
      const sessionLeg: WorkerLegRef =
        ctx.providerId !== undefined && ctx.model !== undefined
          ? { providerId: baseLeg.providerId, model: ctx.model, turnModel: ctx.model }
          : baseLeg;
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

      // Writes: only where a task declared `files`, asked once for the
      // whole call before a subagent starts.
      let writeScope: string[] = [];
      if (tasks.some((t) => (t.files?.length ?? 0) > 0)) {
        writeScope = resolveFanoutScope(tasks, ctx.workingDir);
        const intoState = scopeInsideStateDir(writeScope, deps.agentStateDir);
        if (intoState.length > 0) {
          return error(
            `${SUBAGENT_RUN_TOOL} did not run: the tasks would write in the agent's own state directory (${intoState.join(", ")}). ` +
              "Subagents cannot write there. Name a project directory instead; if the user really wants a change to the agent's own files, tell them.",
            { reason: "agent-state-dir", scope: intoState },
          );
        }
        const grantTurn = grantTurns.get(ctx.sessionId);
        if (ctx.turnId === undefined || grantTurn !== ctx.turnId) {
          deps.approvals.fanoutScopes?.clearTurnGrant(ctx.sessionId);
          grantTurns.delete(ctx.sessionId);
        }
        const declinedInScope =
          deps.approvals.hasDeclinedUnder?.(ctx.sessionId, writeScope) ?? false;
        const alreadyApproved =
          !declinedInScope &&
          (deps.approvals.fanoutScopes?.turnGrantCovers(ctx.sessionId, writeScope) ??
            false);
        try {
          if (!alreadyApproved) {
            const models = [...new Set([...legs.values()].map((l) => l.model))];
            await requireApproval(
              {
                approvals: deps.approvals as ApprovalGate,
                approvalRequired: deps.approvalRequired,
              },
              {
                sessionId: ctx.sessionId,
                tool: SUBAGENT_RUN_TOOL,
                category: "fusion_fanout",
                reason: `${tasks.length} subagent${tasks.length === 1 ? "" : "s"} on ${models.join(", ")} may write in ${writeScope.join(", ")}`,
                preview: describeFanoutPreview(tasks, writeScope),
                affectedResources: [...writeScope],
              },
              ctx.signal,
            );
          }
          deps.approvals.fanoutScopes?.grantForTurn(ctx.sessionId, writeScope);
          if (ctx.turnId !== undefined) {
            grantTurns.delete(ctx.sessionId);
            grantTurns.set(ctx.sessionId, ctx.turnId);
            const oldest = grantTurns.keys().next().value;
            if (grantTurns.size > 256 && oldest !== undefined) {
              grantTurns.delete(oldest);
              // Forgetting the turn must not leave its grant readable.
              deps.approvals.fanoutScopes?.clearTurnGrant(oldest);
            }
          }
        } catch (err) {
          if (err instanceof ApprovalDeniedError && (err.byUser || err.declinedEarlier)) {
            return error(err.message, { reason: "writes-denied", deniedByUser: true });
          }
          return error(
            `${SUBAGENT_RUN_TOOL} did not run: the writes were not approved: ${err instanceof Error ? err.message : String(err)}`,
            { reason: "writes-denied" },
          );
        }
      }

      ledger.record(ctx.sessionId, turnAt, tasks.length);
      const childDepth = depth + 1;
      const originalRequest = deps.resolveOriginalRequest?.(ctx.sessionId);
      const runnerDeps: WorkerRunnerCoreDeps = {
        ...deps,
        workingDir: ctx.workingDir,
        ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}),
      };
      // The turn's spend ceiling (ATO-1670), wired as Fusion wires its
      // turn cap: checked before each subagent starts, every subagent
      // completion priced and added to the turn's spend, and a ceiling
      // reached mid-run stops what is running and starts nothing more.
      // No ceiling set: none of this exists and nothing changes.
      const ceiling = ctx.turnSpend;
      const ceilingAbort = new AbortController();
      let stoppedBy: string | undefined;
      const ceilingStop = (): string | undefined => {
        if (ceiling === undefined) return undefined;
        const spent = ceiling.spentUsd();
        return costCeilingReached(spent, ceiling.ceilingUsd)
          ? subagentCeilingMessage(spent, ceiling.ceilingUsd)
          : undefined;
      };
      const stopForCeiling = (stop: string): void => {
        if (stoppedBy !== undefined) return;
        stoppedBy = stop;
        ceilingAbort.abort(new Error(stop));
      };
      const ceilingOptionsFor = (leg: TaskLeg) => {
        if (ceiling === undefined) return {};
        const pricing = deps.resolveWorkerPricing?.(leg.providerId, leg.model);
        return {
          shouldStart: (): string | undefined => {
            const stop = stoppedBy ?? ceilingStop();
            if (stop === undefined) return undefined;
            stopForCeiling(stop);
            return stop;
          },
          onWorkerUsage: (
            _taskId: string,
            usage: Parameters<typeof estimateUsageCostUsd>[0],
          ): void => {
            if (pricing !== undefined) {
              ceiling.add(estimateUsageCostUsd(usage, pricing));
            }
            const stop = ceilingStop();
            if (stop !== undefined) stopForCeiling(stop);
          },
        };
      };
      const runSignal =
        ceiling === undefined
          ? ctx.signal
          : AbortSignal.any([ctx.signal, ceilingAbort.signal]);
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
          signal: runSignal,
          ...ceilingOptionsFor(group.leg),
          origin: "subagent",
          depth: childDepth,
          ...(writeScope.length === 0 ? {} : { writeScope }),
          approvalRefusal: {
            general: SUBAGENT_APPROVAL_REFUSED,
            reasonFor: subagentRefusalFor,
          },
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
      // Rows the ceiling cut short say so, as Fusion's rows do for its cap,
      // so a stopped subagent is not read as the person's doing.
      const ceilingStopped = stoppedBy as string | undefined;
      if (ceilingStopped !== undefined && !ctx.signal.aborted) {
        for (const [i, r] of results.entries()) {
          if (r.status === "cancelled" && !r.error?.startsWith("not started:")) {
            results[i] = {
              ...r,
              notes: [...(r.notes ?? []), `stopped by the turn's cap: ${ceilingStopped}`],
            };
          }
        }
      }
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
            ...(ceilingStopped === undefined
              ? {}
              : { stoppedBy: "cost-ceiling", stopReason: ceilingStopped }),
          },
        },
        { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
      );
    },
  };
}
