import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolRole } from "../../tools/tool-roles.js";
import type { FusionOrchestratorState } from "../policies/fusion-orchestrator-mode.js";
import type { StepToolSet } from "../policies/step-tool-set.js";
import type { ResourceClass } from "../tool-resource-class.js";
import type { LoopCheckVerdict } from "../progress/loop-contract.js";
// Nominal per-turn tracker resource; public context preserves this exact class type.
import type { ToolLoopTracker } from "../loop-detector.js";
/**
 * Loop-detection signal surfaced upward from a batch execution. The
 * agent loop consumes these after the step completes:
 *  - `warn`: a no-progress repeat was observed; inject a `### notice`.
 *  - `critical`: a call was vetoed (not executed); the synthetic result
 *    already carries the veto instruction.
 *  - `breaker`: the model ignored repeated vetoes — force a graceful
 *    reply to end the turn.
 */
export interface BatchLoopSignal {
  kind: "warn" | "critical" | "breaker";
  tool: string;
  count: number;
  detector: LoopCheckVerdict["detector"];
  warningKey: string;
  /**
   * Veto path only: how many consecutive times THIS call has been
   * refused, counting the refusal that raised this signal. `count` is a
   * detector streak whose calls mostly ran, so it cannot stand in for
   * this number in any user-facing wording.
   */
  blockedCount?: number;
  /**
   * `test_repeat` only: human-readable command label (`pytest -k auth`)
   * for the notice text.
   */
  target?: string;
  /**
   * `test_repeat` only: compressed summary of the previous equivalent
   * run, quoted in the notice so the model sees what re-running
   * reproduced.
   */
  previousSummary?: string;
  /**
   * `read_repeat` only: what the redundant read landed on. Feeds both
   * the notice (path, ranges) and the `loop_detected` event (path,
   * range, fingerprint transition). Line numbers and a path — never any
   * file content.
   */
  read?: {
    /** Canonical (symlink-resolved) path of the file read. */
    path: string;
    /** Range this read returned; `0`/`0` when it returned nothing. */
    startLine: number;
    endLine: number;
    /** Lines visible in the read window. */
    totalLines: number;
    /**
     * Whether the file has content past `totalLines` that the read's
     * byte budget hid. The notice needs it to tell "you asked for a line
     * past the end of the file" apart from "you asked for a line the
     * byte cap hid", which have opposite fixes.
     */
    truncated: boolean;
    /** Compact list of lines already read this turn, e.g. `"1-40, 88-120"`. */
    covered: string;
    /** Content fingerprint this read saw. */
    fingerprint: string;
    /** Fingerprint of the previous read; equal ⇒ the content is unchanged. */
    previousFingerprint: string;
  };
}

/**
 * Static info about one call inside a batch. Carried verbatim back into
 * `BatchExecutionResult.results` so callers can correlate by index.
 */
export interface BatchCallInput {
  /** Position of this call in the model-emitted array. Stable, 0-based. */
  batchIndex: number;
  call: ToolCallPayload;
  /** Pre-computed class — saves re-classifying inside the planner. */
  resourceClass: ResourceClass;
}

export interface BatchExecutionContext {
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
  /**
   * The paths the user named in this session's messages, for the read
   * scope (`ToolContext.readRoots`). Computed by the step from the
   * transcript and handed to every call of the batch unchanged.
   */
  readRoots?: readonly string[];
  /** The step's provider pin, handed to every call (`ToolContext.providerId`). */
  providerId?: string;
  /**
   * Fired immediately before the registry is invoked for each call.
   * Order: matches the order the executor reaches each call (within a
   * serialised group that is batch-index order; across concurrent
   * groups it is undefined). `batchIndex`/`batchSize` echo the inputs
   * so consumers can pair `started` ↔ `finished` events.
   */
  onCallStarted?: (info: { batchIndex: number; batchSize: number }) => void;
  /** Fired once a call's `CompressedToolResult` is in hand (success or error). */
  onCallFinished?: (info: {
    batchIndex: number;
    batchSize: number;
    result: CompressedToolResult;
    durationMs: number;
  }) => void;
  /**
   * Per-turn loop tracker. When present, every non-terminal call is run
   * through the synchronous loop gate (`check` → `recordCall`) before it
   * is dispatched, and its outcome is recorded after execution. Vetoed
   * calls never reach the registry. Absent ⇒ loop detection is disabled
   * for this step (legacy behaviour).
   */
  tracker?: ToolLoopTracker;
  /**
   * The loop's reserved final step: only `reply` / `finish` may run. A
   * non-terminal call is answered with {@link FINAL_STEP_REFUSAL} in its
   * slot and never reaches the registry; a tail terminal still runs.
   * Enforced here rather than by narrowing the prompt's tool catalog,
   * which is stable-prefix bytes.
   */
  terminalOnly?: boolean;
  /**
   * The only names this step may run (`step-tool-set.ts`): the final
   * step's restriction with the names supplied. A non-terminal call
   * outside the set is answered with `toolSetRefusal` in its slot and
   * never reaches the registry; terminals are exempt as everywhere.
   */
  toolSet?: StepToolSet;
  /**
   * Plan mode, read at dispatch time rather than passed as a boolean.
   *
   * A getter for the same reason `dangerous.approvalRequired` is one
   * (see `bootstrap.ts`): a value copied at construction freezes
   * whatever was true at boot, and the whole point of a mode is that
   * the operator flips it mid-session. Absent ⇒ plan mode is off.
   */
  isPlanMode?: () => boolean;
  /**
   * True while this turn is the ORCHESTRATOR's turn in fusion mode (not
   * a worker's, not another run mode). When it is, mutations are held
   * back until the turn has fanned work out at least once — see
   * `fusion-orchestrator-mode.ts`.
   */
  isFusionOrchestrator?: () => boolean;
  /** What this turn has delegated and what came back — see `fusion-orchestrator-mode.ts`. */
  fusionState?: () => FusionOrchestratorState;
  /** Called with a `fusion.delegate` result so the turn's ledger can fold it in. */
  onDelegated?: (result: CompressedToolResult) => void;
  /** The turn's tool role, forwarded to every `ToolContext` (see `tool-roles.ts`). */
  toolRole?: ToolRole;
  /**
   * Names of skills already present in `SessionState.loadedSkills`. A
   * `skill.view` call targeting one of these is short-circuited with a
   * terse "already loaded" result instead of re-reading and re-dumping
   * the body (which bloats context and feeds the re-view loop). The tool
   * is never invoked for such calls. Absent ⇒ no short-circuit.
   */
  loadedSkillNames?: ReadonlySet<string>;
  /**
   * When set, the `pure_read` group fans out in bounded waves of at most
   * this many concurrent calls instead of launching the whole group at
   * once (issue #111). Each wave is awaited before the next starts, so
   * waves execute in original order; the per-input `batchIndex` preserves
   * global result correlation across waves. Other groups are unaffected.
   * Absent ⇒ legacy single-wave fan-out.
   */
  maxWaveSize?: number;
}

export interface BatchExecutionResult {
  /**
   * Always sorted by `batchIndex` ascending — matches the order the
   * model emitted calls. `compressed` is set for both successful and
   * failed invocations (failures are folded into a synthetic
   * `CompressedToolResult{status:"error"}` so the conversation
   * transcript stays in lockstep with the call array). `cancelled`
   * marks calls that never ran because the signal aborted mid-batch.
   */
  results: BatchCallResult[];
  /**
   * `true` if `signal.aborted` interrupted any group mid-flight. Even
   * when `true`, completed calls are still included in `results` so the
   * trace and transcript contain a faithful audit trail before the
   * caller throws `CancelledError`.
   */
  cancelled: boolean;
  /**
   * Loop-detection signals raised by the synchronous gate (warn /
   * critical / breaker), in observation order. Empty when no tracker was
   * supplied or no loop was detected.
   */
  loopSignals: BatchLoopSignal[];
}

export interface BatchCallResult {
  batchIndex: number;
  call: ToolCallPayload;
  resourceClass: ResourceClass;
  /** Final result for the call. Always set unless `cancelled` is true. */
  compressed?: CompressedToolResult;
  /** Wall-clock duration of the registry invocation (ms). 0 when cancelled. */
  durationMs: number;
  /** True when the call never started because the signal aborted first. */
  cancelled: boolean;
}
