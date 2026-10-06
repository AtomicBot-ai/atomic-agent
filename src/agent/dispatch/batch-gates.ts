import { checkPlanMode } from "../policies/plan-mode.js";
import { checkFusionOrchestrator, emptyFusionOrchestratorState } from "../policies/fusion-orchestrator-mode.js";
import { toolSetAdmits, toolSetRefusal } from "../policies/step-tool-set.js";
import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { describeCorruptedCall, findControlMarkers } from "../../tools/control-marker-guard.js";
import { findUnknownArguments } from "../../tools/unknown-argument-guard.js";
import { extractLoopTarget, formatVetoInstruction } from "../progress/loop-notices.js";
import { LOOP_VETO_DENIED_REASON } from "../progress/loop-constants.js";
import type { ToolLoopTracker } from "../loop-detector.js";
import { classifyTestCommand } from "../progress/test-command-key.js";
import { classifyReadResult } from "../progress/read-coverage.js";
import { fingerprintWorkspace } from "../progress/workspace-fingerprint.js";
import type { BatchCallInput, BatchExecutionContext, BatchLoopSignal } from "./batch-contract.js";
/**
 * The error result a call gets instead of running when its arguments
 * are not what the model meant, or `null` when the call is clean.
 *
 * Two checks, in this order. A value carrying the model's own control
 * markup (F37): a `path` holding `<|channel>` is a thought block that
 * fell into the call, and the tool would run on the garbage (it listed
 * an ENAMETOOLONG path as "empty" once, and the model overwrote the
 * input file on that reading). Then a top-level key the tool's schema
 * does not know (F40): `os.shell.run {"cmd":"python3","-e":"<script>"}`
 * used to run a bare `python3` — exit 0, nothing done — with the script
 * silently dropped, and the worker reported the work as done; a tool
 * with no schema is exempt, and F33's key normalisation runs first so a
 * quoted or fused key that means a schema key is not refused.
 *
 * Either refusal is an ordinary error result — recorded in the loop
 * tracker like any other, on the trace row via `details.corrupted` /
 * `details.unknownKeys` — that the model reads on its next step; no
 * parse-recovery budget is spent.
 */
export function refuseBeforeDispatch(
  call: ToolCallPayload,
): CompressedToolResult | null {
  const markers = findControlMarkers(call.args, call.tool);
  if (markers.length > 0) {
    return compressToolResult({
      tool: call.tool,
      status: "error",
      output: describeCorruptedCall(markers),
      details: { corrupted: true, markers },
    });
  }
  const unknown = findUnknownArguments(call.tool, call.args);
  if (unknown !== null) {
    return compressToolResult({
      tool: call.tool,
      status: "error",
      output: unknown.message,
      details: {
        unknownKeys: unknown.unknownKeys,
        expectedKeys: unknown.expectedKeys,
      },
    });
  }
  return null;
}

/**
 * If `input` is a `skill.view` whose target name is already present in
 * `ctx.loadedSkillNames`, return a terse synthetic result so the executor
 * can skip the real invocation. The result carries NO `skillLoaded`
 * detail, so `applyStateEffects` does not re-record or re-dump the body.
 * Returns `null` when the call is not an already-loaded `skill.view`.
 */
export function skillAlreadyLoadedResult(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
): CompressedToolResult | null {
  if (input.call.tool !== "skill.view" || !ctx.loadedSkillNames) return null;
  const rawName = (input.call.args as Record<string, unknown> | undefined)
    ?.name;
  if (typeof rawName !== "string" || rawName.length === 0) return null;
  if (!ctx.loadedSkillNames.has(rawName)) return null;
  return compressToolResult({
    tool: "skill.view",
    status: "ok",
    output: `skill "${rawName}" is already loaded — see ### loaded-skills; proceed without re-viewing.`,
    details: { skillAlreadyLoaded: rawName },
  });
}

/**
 * Synchronous loop gate. Runs `check` → `recordCall` against the tracker
 * BEFORE the call is dispatched. A `critical` verdict (or a tripped
 * breaker) produces a synthetic veto result that replaces the real
 * invocation; the veto outcome is recorded so it is excluded from the
 * no-progress streak (the streak then plateaus at `criticalThreshold`).
 * Terminal verbs and tracker-less steps always proceed unchanged.
 */
/** The tool result a non-terminal call gets on the loop's final step. */
export const FINAL_STEP_REFUSAL = "final step: only reply or finish run here";

/**
 * Refuse a non-terminal call on the loop's reserved final step, or one
 * outside the step's tool set (`step-tool-set.ts`). The prompt's
 * `### notice` already said so; this is what makes it true without
 * narrowing the tool catalog (stable-prefix bytes) for one step. A solo
 * `[reply]` never reaches this gate — terminals are split off before
 * phase 1 — and a `[tool, reply]` batch keeps its reply.
 */
export function runFinalStepGate(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
): { proceed: boolean; vetoResult?: CompressedToolResult } {
  if (input.resourceClass === "terminal") return { proceed: true };
  if (ctx.terminalOnly) {
    return {
      proceed: false,
      vetoResult: {
        tool: input.call.tool,
        status: "error",
        summary: FINAL_STEP_REFUSAL,
        details: { final_step: true, tool: input.call.tool },
        truncated: false,
      },
    };
  }
  if (ctx.toolSet !== undefined && !toolSetAdmits(ctx.toolSet, input.call.tool)) {
    return {
      proceed: false,
      vetoResult: toolSetRefusal(input.call.tool, ctx.toolSet),
    };
  }
  return { proceed: true };
}

/**
 * Refuse a mutating call while plan mode is on.
 *
 * Sits beside `runSyncLoopGate` and shares its shape — a synchronous
 * verdict that either lets the call through or fills its slot — because
 * both answer the same kind of question: is this call going to run at
 * all, decided before anything is dispatched.
 */
export function runPlanModeGate(
  input: BatchCallInput,
  registry: ToolRegistry,
  ctx: BatchExecutionContext,
): { proceed: boolean; vetoResult?: CompressedToolResult } {
  if (!ctx.isPlanMode?.()) return { proceed: true };
  const verdict = checkPlanMode(input.call.tool, registry);
  if (verdict.allowed) return { proceed: true };
  return { proceed: false, vetoResult: verdict.refusal! };
}

/**
 * Fusion's division of labour. Sits beside the plan-mode gate because it
 * answers the same kind of question — is this call going to run at all —
 * and it runs after it: plan mode is the operator's explicit "not yet",
 * and that outranks a mode's internal shape.
 */
export function runFusionOrchestratorGate(
  input: BatchCallInput,
  registry: ToolRegistry,
  ctx: BatchExecutionContext,
): { proceed: boolean; vetoResult?: CompressedToolResult } {
  if (!ctx.isFusionOrchestrator?.()) return { proceed: true };
  const verdict = checkFusionOrchestrator(
    input.call.tool,
    registry,
    ctx.fusionState?.() ?? emptyFusionOrchestratorState(),
  );
  if (verdict.allowed) return { proceed: true };
  return { proceed: false, vetoResult: verdict.refusal! };
}

/**
 * The veto body is an instruction this file writes to the model, not
 * tool output, and the compressor's bare defaults destroy it: measured
 * across every shape this file produces, a veto is 479-689 chars
 * (header, class hint, the reply bullet, and the bullet that actually
 * names the rule), so `capSummary` cuts at 385 and the last line — "Do
 * NOT repeat this exact call. Either try a different approach or close
 * the turn with `reply`…" — never reaches the model. The message whose
 * whole purpose is to end a loop lost the sentence that says how.
 *
 * Every line is load-bearing and the header is line 1, so line-based
 * tail truncation is disabled (it keeps the LAST lines — inert at five
 * lines, kept as a guard rail) and the char budget sits well above the
 * longest veto: the text is generated here, and the only interpolation
 * that could run long is the target, clamped to 60 chars by
 * `sanitizeLoopTarget`. `tool` is not clamped, so an MCP server
 * registering a multi-thousand-character qualified name could still
 * overflow 4 000 — it would simply be cut as it is today.
 */
const VETO_COMPRESS_OPTIONS = {
  maxSummaryLength: 4_000,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

export function runSyncLoopGate(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
  loopSignals: BatchLoopSignal[],
): { proceed: boolean; vetoResult?: CompressedToolResult } {
  if (input.resourceClass === "terminal" || !ctx.tracker) {
    return { proceed: true };
  }
  const { tool, args } = input.call;
  const breakerTripped = ctx.tracker.isBreakerTripped(tool, args);
  // A wandering loop that crossed a spread cap also ends the turn
  // gracefully (the redirect notice did not land). It rides the same
  // breaker path as the consecutive-veto streak. One call, two numbers:
  // whether to stop, and the spread the rule that fired measured — the
  // messages must quote the set of calls they are about (issue #458).
  const wandering = ctx.tracker.wanderingStop(tool, args);
  const wanderingEscalated = wandering.escalated;
  const spreadAtGate = wandering.spread;
  const verdict = ctx.tracker.check(tool, args);
  ctx.tracker.recordCall(tool, args);

  if (verdict.level === "critical" || breakerTripped || wanderingEscalated) {
    const forceBreaker = breakerTripped || wanderingEscalated;
    const count = breakerTripped
      ? Math.max(verdict.count, ctx.tracker.breakerThreshold)
      : verdict.count;
    // Name the invariant that held across the blocked attempts (host for
    // web/HTTP, command name for shell) so the message says WHAT stayed
    // the same instead of only that something did.
    const target = extractLoopTarget(tool, args);
    // A wandering escalation rides this same veto path but its `count` is
    // a spread of DISTINCT arguments; pass the detector so the wording
    // does not claim they were identical.
    //
    // The verdict decides, not the escalation flag. `wanderingStop` stays
    // true after the model stops wandering and settles on repeating one
    // argument -- and borrowing it there would announce "N different
    // attempts" about a verbatim repeat, quoting a count the verdict never
    // established. `check` reads BOTH ladders, so a stop on either one
    // carries a `wandering` verdict here and is worded from its own spread.
    const detector =
      wanderingEscalated && verdict.detector === "wandering"
        ? "wandering"
        : verdict.detector;
    const vetoResult = compressToolResult(
      {
        tool,
        status: "error",
        output: formatVetoInstruction({ tool, count, target, detector }),
        details: {
          deniedReason: LOOP_VETO_DENIED_REASON,
          loopCount: count,
          detector,
        },
      },
      VETO_COMPRESS_OPTIONS,
    );
    ctx.tracker.recordOutcome(tool, args, vetoResult);
    // The signal names what ended the turn. When the escalation alone
    // forced the breaker, that is the wandering cap even if THIS call is a
    // verbatim repeat (a parallel batch can carry the spread past the cap
    // before anything is refused, and the window keeps it there). Taking
    // the repeat verdict here would end the turn on a repeat's count
    // when the spread is what stopped it. The veto body above keeps the
    // repeat wording: it describes the call, this describes the stop.
    const stoppedByWandering =
      wanderingEscalated && !breakerTripped && verdict.level !== "critical";
    loopSignals.push({
      kind: forceBreaker ? "breaker" : "critical",
      tool,
      count: stoppedByWandering ? spreadAtGate : count,
      detector: stoppedByWandering ? "wandering" : detector,
      warningKey: verdict.warningKey,
      // Read AFTER `recordOutcome` noted the refusal above, so it counts
      // this one and is therefore always >= 1 on this path — the reply
      // never has to fall back to a number it cannot stand behind.
      blockedCount: ctx.tracker.vetoStreak(tool, args),
    });
    return { proceed: false, vetoResult };
  }

  if (verdict.level === "warn") {
    loopSignals.push({
      kind: "warn",
      tool,
      count: verdict.count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
  }

  // Test-repeat gate (issue #118, companion of #114): a recognized test
  // command re-run against an unchanged workspace fingerprint is a
  // stronger no-progress signal than the generic byte-identical repeat —
  // it survives timeout-only argument variation and timing noise in the
  // output. Warn-only by design (the issue's acceptance criteria): the
  // call always proceeds, which is also the intentional-repeat path, and
  // the generic detectors above stay fully active. The fingerprint walk
  // runs only here — recognized test commands only — never on ordinary
  // shell calls. A `null` fingerprint (missing / oversized cwd) disables
  // detection for this call rather than risking a false warning.
  const testCommand = classifyTestCommand(tool, args, ctx.workingDir);
  if (testCommand !== null) {
    const fingerprint = fingerprintWorkspace(testCommand.cwd);
    if (fingerprint !== null) {
      const repeat = ctx.tracker.checkTestRepeat(testCommand.key, fingerprint);
      ctx.tracker.recordTestRun(testCommand.key, fingerprint, tool, args);
      if (repeat.repeat) {
        loopSignals.push({
          kind: "warn",
          tool,
          count: repeat.count,
          detector: "test_repeat",
          warningKey: `test_repeat:${testCommand.key}`,
          target: testCommand.label,
          ...(repeat.previousSummary !== undefined
            ? { previousSummary: repeat.previousSummary }
            : {}),
        });
      }
    }
  }
  return { proceed: true };
}

/**
 * Read-coverage gate (issue #114, companion of #118). Runs AFTER the call
 * completed, because the facts it needs — which file the read resolved
 * to, which version of it was read, and which lines came back — are
 * properties of the result, not of the arguments. Requested
 * `offset`/`limit` are clamped and can be negative, so they cannot
 * answer any of the three.
 *
 * Warn-only, like the test-repeat detector: the read has already
 * happened, so there is nothing to block, and a scan over many distinct
 * files never produces a signal at all (each file's coverage grows, and
 * only a read that returns nothing new counts). Non-read tools and
 * failed reads return `null` from `classifyReadResult` and leave no
 * trace here.
 */
export function observeReadCoverage(
  input: BatchCallInput,
  result: CompressedToolResult,
  tracker: ToolLoopTracker,
  loopSignals: BatchLoopSignal[],
): void {
  const observation = classifyReadResult(input.call.tool, result);
  if (observation === null) return;
  const repeat = tracker.checkReadRepeat(observation);
  tracker.recordRead(observation);
  if (!repeat.repeat) return;
  loopSignals.push({
    kind: "warn",
    tool: input.call.tool,
    count: repeat.count,
    detector: "read_repeat",
    // Keyed by file VERSION: editing the file starts a fresh warn bucket,
    // so a nudge about the old content is never suppressed for the new.
    warningKey: `read_repeat:${observation.path}:${observation.contentHash}`,
    read: {
      path: observation.path,
      startLine: observation.span?.start ?? 0,
      endLine: observation.span?.end ?? 0,
      totalLines: observation.totalLines,
      truncated: observation.truncated,
      covered: repeat.covered,
      fingerprint: observation.contentHash,
      // `checkReadRepeat` only reports a repeat when it has seen this
      // file before, so the previous fingerprint is always present here;
      // the fallback keeps the type honest without a non-null assertion.
      previousFingerprint:
        repeat.previousFingerprint ?? observation.contentHash,
    },
  });
}
