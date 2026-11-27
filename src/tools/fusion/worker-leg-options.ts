import { DEFAULT_FUSION_CLOUD_WORKERS } from "../../config/llm-run-mode-config.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import type {
  FusionWorkerRunnerOptionsExtras,
  WorkerRunnerCoreOptions,
} from "./worker-runner-core.js";

/**
 * The runner options every leg of a fan-out gets, shared by
 * `fusion.delegate` (its worker leg and its role legs) and `subagent.run`
 * (ATO-2446). Each tool adds its own on top: Fusion its contract, caps,
 * escalation and workspaces; `subagent.run` its origin, depth, refusals
 * and spend ceiling.
 */

/** Where one leg's workers run, and the label its rows carry. */
export interface WorkerLegTarget {
  providerId: string;
  /** The display label (`WorkerRunnerCoreOptions.workerModel`). */
  workerModel: string;
  /** The model each turn asks `providerId` for; absent, its own model. */
  turnModel?: string | undefined;
}

/**
 * How many workers run at once on a leg the caller did not size itself:
 * one at a time on a local (slot-affine) server, whose slots are nobody's
 * measurement; on a cloud leg, the task count up to the cloud cap.
 */
export function legWorkerWidth(
  local: boolean,
  taskCount: number,
  cloudWorkers: number | undefined,
): number {
  return local
    ? 1
    : Math.max(
        1,
        Math.min(taskCount, cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS),
      );
}

export interface CoreWorkerOptionsInput {
  parentSessionId: string;
  tasks: readonly DelegateTask[];
  leg: WorkerLegTarget;
  maxWorkers: number;
  /** The leg is local: the local floors, the slot probe, the health check. */
  localLeg: boolean;
  mode: Pick<
    ResolvedRunMode,
    "workerMaxSteps" | "workerTimeoutMs" | "workerReasoning"
  >;
  /**
   * The per-step output cap: `mode.workerMaxOutputTokens`, or what the
   * caller derived for a local pool. Undefined: none sent.
   */
  workerMaxOutputTokens: number | undefined;
  signal: AbortSignal;
  originalRequest?: string | undefined;
  /** Undefined: no `writeScope` key at all. */
  writeScope?: readonly string[] | undefined;
}

export function coreWorkerOptions(
  input: CoreWorkerOptionsInput,
): WorkerRunnerCoreOptions & Pick<FusionWorkerRunnerOptionsExtras, "localLeg"> {
  const { leg, mode } = input;
  return {
    ...(input.originalRequest === undefined
      ? {}
      : { originalRequest: input.originalRequest }),
    parentSessionId: input.parentSessionId,
    tasks: input.tasks,
    maxWorkers: input.maxWorkers,
    providerId: leg.providerId,
    workerModel: leg.workerModel,
    ...(leg.turnModel === undefined ? {} : { turnModel: leg.turnModel }),
    workerMaxSteps: mode.workerMaxSteps,
    workerTimeoutMs: mode.workerTimeoutMs,
    localLeg: input.localLeg,
    ...(mode.workerReasoning === undefined
      ? {}
      : { workerReasoning: mode.workerReasoning }),
    ...(input.workerMaxOutputTokens === undefined
      ? {}
      : { workerMaxOutputTokens: input.workerMaxOutputTokens }),
    ...(input.writeScope === undefined ? {} : { writeScope: input.writeScope }),
    signal: input.signal,
  };
}
