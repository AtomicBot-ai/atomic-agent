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
import { getConfig } from "../../config/index.js";
import { workerReplyAllowance } from "../../local-llm/worker-slots.js";
import type { ToolDefinition } from "../tool-registry.js";
import { parseVerifyRunArgs } from "../verify/verify-run-args.js";
import { parseDelegateArgs, readJsonArg } from "./delegate-args.js";
import { MAX_CONTRACT_CHECKS, MAX_CONTRACT_CHECK_ITEM_CHARS, type ContractCheck } from "./contract.js";
import {
  applyCheckOutcomes,
  applyContractFindings,
  contractChecklistPasses,
  inspectContractProvides,
  renderContractLine,
  runContractChecks,
  type ContractCheckRunner,
  type ContractReport,
} from "./contract-checks.js";
import {
  completedWaveNotes,
  contractForWave,
  dependencyWarnings,
  planWaves,
} from "./contract-waves.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  delegateOutcome,
  fanoutSpend,
  formatDelegateOutput,
  type WorkerPricing,
  type WorkerTaskResult,
} from "./worker-result.js";

export const FUSION_DELEGATE_TOOL = "fusion.delegate";

const MAX_BEHAVIOR_REPAIR_ROUNDS = 3;

interface PendingCheckDefinition {
  /** Opaque verify.run arguments, captured by value; never executed here. */
  spec?: string;
  specComplete?: boolean;
  item?: string;
  /** null pins a call-level check; undefined leaves an invalid binding repairable. */
  task?: string | null;
}

interface PendingBehaviorChecklist {
  turnId: string | AbortSignal;
  /** Set only after the complete checklist has passed argument validation. */
  signature?: string;
  /** Before validation, preserve known names and item count while allowing argument repair. */
  requiredNamedItems?: readonly string[];
  requiredDefinitions?: readonly PendingCheckDefinition[];
  minimumItems?: number;
  items: readonly string[];
  failedRounds: number;
  remaining: readonly string[];
  lastVerdict?: string;
}

function canonicalChecklistValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalChecklistValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalChecklistValue(entry)]),
    );
  }
  return value;
}

function behaviorChecklistSignature(checks: readonly ContractCheck[]): string {
  return JSON.stringify(canonicalChecklistValue(checks));
}

function behaviorChecklistItems(checks: readonly ContractCheck[]): string[] {
  return checks.map((check, i) =>
    typeof check.item === "string" && check.item.trim().length > 0
      ? check.item.trim()
      : `check-${i + 1}`,
  );
}

/**
 * Recover only public checklist labels from rejected raw args for a fail-closed verdict.
 * Nothing returned here is trusted for execution; parsing still fails and no worker starts.
 */
function rawBehaviorChecklistItems(rawArgs: Record<string, unknown>, namedOnly = false): string[] {
  const contract = readJsonArg(rawArgs.contract);
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return [];
  const checks = (contract as Record<string, unknown>).checks;
  if (!Array.isArray(checks)) return namedOnly || checks === undefined || checks === null ? [] : ["behavior acceptance"];
  return checks.slice(0, MAX_CONTRACT_CHECKS).flatMap((check, i) => {
    if (check !== null && typeof check === "object" && !Array.isArray(check)) {
      const item = (check as Record<string, unknown>).item;
      if (typeof item === "string" && item.trim().length > 0) {
        return [item.trim().slice(0, MAX_CONTRACT_CHECK_ITEM_CHARS)];
      }
    }
    return namedOnly ? [] : [`check-${i + 1}`];
  });
}

function rawBehaviorChecklistSize(rawArgs: Record<string, unknown>): number {
  const contract = readJsonArg(rawArgs.contract);
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return 0;
  const checks = (contract as Record<string, unknown>).checks;
  return Array.isArray(checks) ? checks.length : checks === undefined || checks === null ? 0 : 1;
}

/** Structural validation only: reuse the verifier's parser, never run a second verifier. */
function completeVerifySpec(spec: Record<string, unknown>): boolean {
  try { parseVerifyRunArgs(spec); return true; } catch { return false; }
}

/** Missing fields may be filled in an incomplete spec; captured values cannot change. */
function preservesSpecValues(before: unknown, after: unknown): boolean {
  if (Array.isArray(before)) {
    return Array.isArray(after) && before.length === after.length &&
      before.every((value, i) => preservesSpecValues(value, after[i]));
  }
  if (before !== null && typeof before === "object") {
    return after !== null && typeof after === "object" && !Array.isArray(after) &&
      Object.entries(before).every(([key, value]) => Object.hasOwn(after, key) &&
        preservesSpecValues(value, (after as Record<string, unknown>)[key]));
  }
  return before === after;
}

/** Preserve assertions independently of repairable labels, task bindings or task args. */
function pinBehaviorCheckDefinitions(
  rawArgs: Record<string, unknown>,
  previous: readonly PendingCheckDefinition[] = [],
): PendingCheckDefinition[] {
  const contract = readJsonArg(rawArgs.contract);
  const rawTasks = readJsonArg(rawArgs.tasks);
  const taskIds = new Set(Array.isArray(rawTasks) ? rawTasks.flatMap((task) =>
    task !== null && typeof task === "object" && !Array.isArray(task) &&
      typeof task.id === "string" && task.id.trim().length > 0 ? [task.id.trim()] : [],
  ) : []);
  const checks = contract !== null && typeof contract === "object" && !Array.isArray(contract)
    ? (contract as Record<string, unknown>).checks : undefined;
  const current: PendingCheckDefinition[] = Array.isArray(checks) ? checks.slice(0, MAX_CONTRACT_CHECKS).map((check) => {
    if (check === null || typeof check !== "object" || Array.isArray(check)) return {};
    const { item, task, ...spec } = check as Record<string, unknown>;
    return {
      ...(Object.keys(spec).length === 0 ? {} : {
        spec: JSON.stringify(canonicalChecklistValue(spec)), specComplete: completeVerifySpec(spec),
      }),
      ...(typeof item === "string" && item.trim().length > 0 && item.trim().length <= MAX_CONTRACT_CHECK_ITEM_CHARS
        ? { item: item.trim() } : {}),
      ...(task === undefined || task === null ? { task: null }
        : typeof task === "string" && taskIds.has(task.trim()) ? { task: task.trim() } : {}),
    };
  }) : [];
  // Repeated invalid requests may fill missing definitions, never overwrite earlier ones.
  return Array.from({ length: Math.max(previous.length, current.length) }, (_, i) => {
    const prior = previous[i];
    const next = current[i];
    const extend = prior?.spec === undefined || (prior.specComplete === false && next?.spec !== undefined &&
      preservesSpecValues(JSON.parse(prior.spec), JSON.parse(next.spec)));
    return {
      spec: extend ? next?.spec : prior.spec,
      specComplete: extend ? next?.specComplete : prior.specComplete,
      item: prior?.item ?? next?.item,
      task: prior?.task !== undefined ? prior.task : next?.task,
    };
  });
}

function preservesBehaviorCheckDefinitions(
  pinned: readonly PendingCheckDefinition[],
  checks: readonly ContractCheck[],
): boolean {
  return pinned.every((definition, i) => {
    const check = checks[i];
    if (check === undefined) return false;
    const { item, task, ...spec } = check;
    const preservedSpec = definition.spec === undefined || (definition.specComplete === false
      ? preservesSpecValues(JSON.parse(definition.spec), spec)
      : definition.spec === JSON.stringify(canonicalChecklistValue(spec)));
    return preservedSpec &&
      (definition.item === undefined || definition.item === item) &&
      (definition.task === undefined || definition.task === (task ?? null));
  });
}

function uncheckedChecklistVerdict(items: readonly string[], detail: string): string {
  const report: ContractReport = {
    findings: [],
    checks: items.map((item) => ({ item, checked: false, ok: false, detail })),
  };
  return renderContractLine(report) ?? `contract: checklist: ${items.join("; ")}=UNCHECKED`;
}
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
  /** Unique per operator turn, independent of request text. Without it, callers
   * must reuse the turn signal for repairs and provide a new signal next turn. */
  resolveOperatorTurnId?: (sessionId: string) => string | undefined;
  /** Opt-in requirement for named checks. Production reads the operator's flag live. */
  requireBehaviorChecklist?: boolean | (() => boolean);
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
  }, details.checklistPinned === true ? { maxSummaryLength: output.length + 100 } : {});
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
  const pendingChecklistBySession = new Map<string, PendingBehaviorChecklist>();
  return {
    name: FUSION_DELEGATE_TOOL,
    description:
      "Delegate independent parts of the work to local worker agents that run concurrently. You choose how many run at once with `maxWorkers`. A task that needs more room than the default can say so with `maxSteps` / `timeoutMs`; both are clamped to a multiple of the configured default and the result tells you when that happened. A `contract` can carry owners, provides, requires and checks; named `contract.checks` are optional unless the operator enables `llm.runMode.fusion.requireBehaviorChecklist`. Treat `contract.checks` as the behavior checklist: give each check a short `item` label plus its `verify.run` arguments; FAIL or UNCHECKED makes the call fail. Give each `provides` entry a one-line `shape` (a signature, a return shape, what a field means): it is pasted into the brief of every worker that relies on it, and matching names is not matching meaning. For executable `shape` meaning, include a `verify.run` boundary assertion in `contract.checks`; `shape` alone is guidance, not proof. Args: { tasks: [{ id, instructions, title?, deliverable?, files?, maxSteps?, timeoutMs? }], maxWorkers?, contract? }.",
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
      const turnId = deps.resolveOperatorTurnId?.(ctx.sessionId) ?? ctx.signal;
      let pendingChecklist = pendingChecklistBySession.get(ctx.sessionId);
      // A new operator turn is a new job, not another repair round.
      if (pendingChecklist !== undefined && pendingChecklist.turnId !== turnId) {
        pendingChecklistBySession.delete(ctx.sessionId);
        pendingChecklist = undefined;
      }

      const requireBehaviorChecklist = typeof deps.requireBehaviorChecklist === "function"
        ? deps.requireBehaviorChecklist()
        : deps.requireBehaviorChecklist === true;
      const parsed = parseDelegateArgs(rawArgs);
      if (!parsed.ok) {
        const recoveredItems = rawBehaviorChecklistItems(rawArgs);
        // A plain argument error is not a failed behavior check. In particular it
        // must not turn a missing-check policy refusal into a permanent evidence block.
        if (pendingChecklist !== undefined || rawBehaviorChecklistSize(rawArgs) > 0) {
          const items = pendingChecklist?.items ?? (recoveredItems.length > 0 ? recoveredItems : ["behavior acceptance"]);
          const line = uncheckedChecklistVerdict(
            items,
            `not run — fusion.delegate arguments were invalid: ${parsed.error}`,
          );
          if (pendingChecklist === undefined) {
            // Placeholder labels are not identities: unnamed checks can be named,
            // but neither declared item count nor known names may disappear.
            pendingChecklist = {
              turnId, items, remaining: items, failedRounds: 0,
              requiredNamedItems: rawBehaviorChecklistItems(rawArgs, true),
              minimumItems: rawBehaviorChecklistSize(rawArgs),
              requiredDefinitions: pinBehaviorCheckDefinitions(rawArgs),
            };
          }
          if (pendingChecklist !== undefined) {
            pendingChecklistBySession.set(ctx.sessionId, {
              ...pendingChecklist,
              ...(pendingChecklist.signature === undefined ? {
                requiredDefinitions: pinBehaviorCheckDefinitions(rawArgs, pendingChecklist.requiredDefinitions),
              } : {}),
              remaining: [...pendingChecklist.items],
              lastVerdict: line,
            });
          }
          return error(`${parsed.error}\n${line}`, {
            field: "tasks",
            reason: "behavior-checklist-invalid",
            checklistPassed: false,
            checklistVerdict: line,
            requiredChecklistItems: [...items],
          });
        }
        return error(parsed.error, { field: "tasks" });
      }

      const originalRequest = deps.resolveOriginalRequest?.(ctx.sessionId);
      const checklist = parsed.contract?.checks ?? [];
      const checklistSignature = behaviorChecklistSignature(checklist);
      // Pin declared items before the optional naming gate too. A later missing
      // checklist must not downgrade this declaration to a policy-only refusal.
      if (checklist.length > 0 && pendingChecklist === undefined) {
        const items = behaviorChecklistItems(checklist);
        pendingChecklist = {
          turnId, items, remaining: items, failedRounds: 0,
          requiredNamedItems: rawBehaviorChecklistItems(rawArgs, true),
          minimumItems: checklist.length,
          requiredDefinitions: pinBehaviorCheckDefinitions(rawArgs),
        };
        pendingChecklistBySession.set(ctx.sessionId, pendingChecklist);
      }
      if (
        pendingChecklist !== undefined &&
        pendingChecklist.failedRounds >= MAX_BEHAVIOR_REPAIR_ROUNDS
      ) {
        const line = pendingChecklist.lastVerdict ?? uncheckedChecklistVerdict(
          pendingChecklist.items,
          "not run — behavior repair budget exhausted",
        );
        return error(
          `behavior repair budget exhausted after ${pendingChecklist.failedRounds} failed full-checklist rounds; remaining failing/unchecked items: ${pendingChecklist.remaining.join("; ")}\n${line}`,
          {
            reason: "behavior-repair-budget-exhausted",
            checklistPinned: true,
            checklistPassed: false,
            checklistVerdict: line,
            remainingChecklistItems: [...pendingChecklist.remaining],
            failedRounds: pendingChecklist.failedRounds,
            maxRounds: MAX_BEHAVIOR_REPAIR_ROUNDS,
            requiredChecklistItems: [...pendingChecklist.items],
          },
        );
      }
      if (pendingChecklist !== undefined && (
        pendingChecklist.signature === undefined
          ? checklist.length < (pendingChecklist.minimumItems ?? pendingChecklist.items.length) ||
            (pendingChecklist.requiredNamedItems ?? pendingChecklist.items)
              .some((item) => !behaviorChecklistItems(checklist).includes(item)) ||
            !preservesBehaviorCheckDefinitions(pendingChecklist.requiredDefinitions ?? [], checklist)
          : pendingChecklist.signature !== checklistSignature
      )) {
        const line = uncheckedChecklistVerdict(
          pendingChecklist.items,
          "not rerun — attempted fan-out changed or omitted the pinned checklist",
        );
        return error(
          `the behavior checklist is pinned for this operator turn; rerun every original item unchanged: ${pendingChecklist.items.join("; ")}\n${line}`,
          {
            reason: "behavior-checklist-changed",
            checklistPinned: true,
            checklistPassed: false,
            checklistVerdict: line,
            requiredChecklistItems: [...pendingChecklist.items],
          },
        );
      }

      if (pendingChecklist !== undefined && pendingChecklist.signature === undefined) {
        pendingChecklist = {
          ...pendingChecklist,
          requiredDefinitions: pinBehaviorCheckDefinitions(rawArgs, pendingChecklist.requiredDefinitions),
        };
        pendingChecklistBySession.set(ctx.sessionId, pendingChecklist);
      }
      if (requireBehaviorChecklist) {
        if (checklist.length === 0) {
          const line = uncheckedChecklistVerdict(
            ["behavior acceptance"],
            "not run — no named contract.checks item was declared before fan-out",
          );
          return error(`behavior checklist required before fan-out\n${line}`, {
            reason: "behavior-checklist-required",
            checklistPolicyRefusal: true,
            checklistPassed: false,
            checklistVerdict: line,
            requiredChecklistItems: ["behavior acceptance"],
          });
        }
        const unnamed = checklist
          .map((check, i) =>
            typeof check.item === "string" && check.item.trim().length > 0 ? undefined : `check-${i + 1}`,
          )
          .filter((item): item is string => item !== undefined);
        if (unnamed.length > 0) {
          const items = behaviorChecklistItems(checklist);
          const line = uncheckedChecklistVerdict(
            items,
            "not run — the enabled checklist policy requires a non-empty item label for every check",
          );
          return error(`named behavior checklist required before fan-out\n${line}`, {
            reason: "behavior-checklist-items-must-be-named",
            checklistPassed: false,
            checklistVerdict: line,
            unnamedChecklistItems: unnamed,
            requiredChecklistItems: items,
          });
        }
      }
      // Pin before dispatch too: a refused or interrupted fan-out cannot erase
      // the checklist. No full-checklist round has failed yet.
      if (checklist.length > 0 && pendingChecklist?.signature === undefined) {
        pendingChecklist = {
          turnId,
          signature: checklistSignature,
          items: behaviorChecklistItems(checklist),
          remaining: behaviorChecklistItems(checklist),
          failedRounds: 0,
        };
        pendingChecklistBySession.set(ctx.sessionId, pendingChecklist);
      }
      const failBeforeChecks = (output: string, details: Record<string, unknown>): CompressedToolResult => {
        if (checklist.length === 0) return error(output, details);
        const report: ContractReport = { findings: [], checks: checklist.map((check, i) => ({
          ...(check.task === undefined ? {} : { task: check.task }),
          item: behaviorChecklistItems(checklist)[i], checked: false, ok: false, detail: "fan-out did not complete",
        })) };
        const line = renderContractLine(report)!;
        if (pendingChecklist !== undefined) {
          pendingChecklistBySession.set(ctx.sessionId, {
            ...pendingChecklist,
            remaining: [...pendingChecklist.items],
            lastVerdict: line,
          });
        }
        return compressToolResult({ tool: FUSION_DELEGATE_TOOL, status: "error", output: output + "\n" + line,
          details: { ...details, checklistPassed: false, checklistVerdict: line, contract: report } }, { maxSummaryLength: output.length + line.length + 100 });
      };

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
        return failBeforeChecks(
          `the fan-out was not approved: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "fan-out-denied" },
        );
      }

      // The orchestrator's brief is a summary, and summaries were thin
      // enough that workers built the wrong thing or scavenged the disk
      // for the missing spec. Every worker also gets what was asked.
      // A local worker's time limit is sized from the machine's measured
      // speed (F19); a cloud leg has no such measurement and keeps the
      // configured ceiling.
      const localTokensPerSecond = Number.isFinite(poolSize)
        ? (deps.localTokensPerSecond?.() ?? null)
        : null;
      // The reply cap the local pool was divided by (`workerSlotFootprint`
      // sizes each worker's reply at `workerReplyAllowance`, not at the raw
      // `completionMaxTokens`). A cap above that allowance is sent as the
      // workers' own, so no worker can write past its share of the shared
      // context; an operator's `workerMaxOutputTokens` still wins, a cap
      // at or below the allowance changes nothing, and a cloud leg (no
      // pool, `poolSize` infinite) is never capped here.
      const localReplyCap = getConfig().localModels.completionMaxTokens;
      const workerMaxOutputTokens =
        mode.workerMaxOutputTokens ??
        (Number.isFinite(poolSize) &&
        localReplyCap > workerReplyAllowance(localReplyCap)
          ? workerReplyAllowance(localReplyCap)
          : undefined);

      // The order the contract imposes (F45): a task that requires what
      // a sibling provides runs in a later wave than that sibling, so it
      // is not sent to wait for a file that does not exist yet. Without
      // a contract, or without a satisfiable `requires`, the plan is one
      // wave holding every task — the fan-out as it always ran.
      const plan = planWaves(
        parsed.tasks.map((t) => t.id),
        parsed.contract,
      );
      const ordered = plan.dependencies.size > 0;
      // What the waves add to the contract's own warnings: a cycle, and
      // every provider that had not delivered when its dependent ran.
      // Each wave's block carries everything known so far; the result's
      // `contract:` line carries all of it.
      const waveWarnings: string[] =
        plan.cycle === undefined ? [] : [plan.cycle];

      let results: WorkerTaskResult[];
      try {
        const finished = new Map<string, WorkerTaskResult>();
        for (const wave of plan.waves) {
          waveWarnings.push(
            ...dependencyWarnings(wave, plan.dependencies, finished),
          );
          // Fresh each wave, not accumulated: the notes are recomputed
          // from everything finished so far, so appending them to the
          // running warning list would repeat every earlier wave.
          const contract = contractForWave(parsed.contract, [
            ...waveWarnings,
            ...completedWaveNotes(finished),
          ]);
          const waveResults = await runWorkerTasks(deps, {
            ...(originalRequest === undefined ? {} : { originalRequest }),
            ...(contract === undefined ? {} : { contract }),
            parentSessionId: ctx.sessionId,
            tasks: parsed.tasks.filter((t) => wave.includes(t.id)),
            maxWorkers,
            providerId: workerProviderId,
            workerModel,
            workerMaxSteps: mode.workerMaxSteps,
            workerTimeoutMs: mode.workerTimeoutMs,
            localTokensPerSecond,
            ...(mode.workerReasoning === undefined
              ? {}
              : { workerReasoning: mode.workerReasoning }),
            ...(workerMaxOutputTokens === undefined
              ? {}
              : { workerMaxOutputTokens }),
            writeScope,
            signal: ctx.signal,
          });
          for (const result of waveResults) finished.set(result.id, result);
        }
        // In the caller's task order, whatever wave each ran in.
        results = parsed.tasks.flatMap((t) => {
          const result = finished.get(t.id);
          return result === undefined ? [] : [result];
        });
      } catch (err) {
        // `runWorkerTasks` is written not to throw; if it ever does, the
        // orchestrator still gets a readable result rather than a dead turn.
        return failBeforeChecks(
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
        // `results` goes in so a task that never ran is not accused of
        // failing to provide: a cancelled fan-out leaves the disk empty
        // for reasons that are not the worker's.
        const provides = await inspectContractProvides(
          parsed.contract,
          parsed.tasks,
          ctx.workingDir,
          { results, signal: ctx.signal },
        );
        results = applyContractFindings(results, provides.findings);
        const checks = await runContractChecks(
          parsed.contract.checks ?? [],
          deps.runChecks,
          { workingDir: ctx.workingDir, signal: ctx.signal },
        );
        results = applyCheckOutcomes(results, checks.outcomes);
        // What the call was run with despite the contract — a require
        // nobody provides, a provide nothing can check, a cycle in the
        // requires, a provider that had not delivered when its dependent
        // ran. The workers read it in their block; the orchestrator
        // reads it here, on the line and in the details.
        const warnings = [...(parsed.contract.warnings ?? []), ...waveWarnings];
        contract = {
          findings: provides.findings,
          ...(provides.providesSkipped === undefined
            ? {}
            : { providesSkipped: provides.providesSkipped }),
          checks: checks.outcomes,
          ...(checks.checksSkipped === undefined
            ? {}
            : { checksSkipped: checks.checksSkipped }),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }
      const contractLine =
        contract === undefined ? undefined : renderContractLine(contract);
      const checklistPasses =
        contract === undefined ? true : contractChecklistPasses(contract);

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
        summary: checklistPasses
          ? `${okCount}/${results.length} ok — merging`
          : `${okCount}/${results.length} ok — checklist blocked`,
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
      let behaviorRepairRound: number | undefined;
      if (checklist.length > 0) {
        if (!checklistPasses) {
          behaviorRepairRound = (pendingChecklist?.failedRounds ?? 0) + 1;
          pendingChecklistBySession.set(ctx.sessionId, {
            turnId,
            signature: checklistSignature,
            items: behaviorChecklistItems(checklist),
            failedRounds: behaviorRepairRound,
            remaining: (contract?.checks ?? [])
              .filter((check) => !check.ok || check.checked === false)
              .map((check) => check.item!),
            ...(contractLine === undefined ? {} : { lastVerdict: contractLine }),
          });
        } else {
          // PASS verifies the current bytes, but it does not release the checklist.
          // Any later worker round in this operator turn must rerun the same full list.
          pendingChecklistBySession.set(ctx.sessionId, {
            turnId,
            signature: checklistSignature,
            items: behaviorChecklistItems(checklist),
            failedRounds: pendingChecklist?.failedRounds ?? 0,
            remaining: [],
            ...(contractLine === undefined ? {} : { lastVerdict: contractLine }),
          });
        }
      }
      // What the fan-out cost on the worker leg, when its model is priced
      // (a cloud leg with a catalogue entry); a local leg resolves to no
      // pricing and the header says nothing.
      const pricing = deps.resolveWorkerPricing?.(
        workerProviderId,
        workerModel,
      );
      const spend =
        pricing === undefined
          ? null
          : fanoutSpend(results, pricing, workerModel);
      const compressed = compressToolResult(
        {
          tool: FUSION_DELEGATE_TOOL,
          status: outcome === "all_failed" || !checklistPasses ? "error" : "ok",
          output: `${formatDelegateOutput(results, deps.outputCharCap + (contractLine?.length ?? 0), {
            ...(contractLine === undefined ? {} : { contractLine }),
            spend,
            ...(ordered ? { waves: plan.waves } : {}),
          })}${hint}`,
          details: {
            tasks: results,
            outcome,
            // No declared checks means no checklist verdict, not a vacuous PASS.
            ...(checklist.length === 0
              ? { checklistNotRequired: !requireBehaviorChecklist }
              : { checklistPassed: checklistPasses }),
            ...(contractLine === undefined ? {} : { checklistVerdict: contractLine }),
            ...(behaviorRepairRound === undefined
              ? {}
              : {
                  behaviorRepair: {
                    round: behaviorRepairRound,
                    maxRounds: MAX_BEHAVIOR_REPAIR_ROUNDS,
                    remaining: Math.max(0, MAX_BEHAVIOR_REPAIR_ROUNDS - behaviorRepairRound),
                  },
                }),
            maxWorkers,
            requestedWorkers: requested,
            ...(Number.isFinite(poolSize) ? { slotPoolSize: poolSize } : {}),
            // The wave plan, for the orchestrator and the trace's tool
            // row alike — only when the contract ordered anything.
            ...(ordered ? { waves: plan.waves } : {}),
            ...(contract === undefined ? {} : { contract }),
            ...(spend === null ? {} : { workerSpendUsd: spend.usd }),
          },
        },
        { maxSummaryLength: deps.outputCharCap + (contractLine?.length ?? 0) + 400, maxTailLines: 2000 },
      );
      // A long status header or a compressor cap may still cut the table.
      // Preserve the authoritative verdict independently of worker prose.
      if (contractLine !== undefined && !compressed.summary.includes(contractLine)) {
        return { ...compressed, summary: `${contractLine}\n${compressed.summary}` };
      }
      return compressed;
    },
  };
}
