import { readTurnIdentity } from "../progress/read-coverage.js";
import type { ReadTurnIdentity } from "../../session/conversation-turn.js";
import type { StepContext, StepDependencies, StepOutcome, StepTerminal } from "./step-contract.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { StepDispatchPlan } from "./step-evidence.js";
import type { BatchExecutionResult } from "../dispatch/batch-contract.js";
import type { ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { compressToolResult, fullToolResult } from "../../compressor/result-compressor.js";
import { evidenceMarks } from "./step-evidence.js";
import type { SessionState } from "../../session/session-state.js";
import { rememberConversationPackStart, recordLoadedTool, recordLatestResult, recordTurn, recordLoadedSkill, recordWorldSnapshot } from "../../session/session-state.js";
import { getConfig } from "../../config/index.js";
import { isRareToolName, getToolDescriptorByName } from "../../prompt/tool-descriptors.js";
import { resourceClassFor } from "../tool-resource-class.js";
import { recordProgressNote, formatProgressNoteNotice, progressNoteText } from "../progress-note-reply.js";
import { CancelledError } from "../../llm/index.js";
import type { StepEvent } from "../step-events.js";
import { capBatchSummaries } from "../batch-summary-cap.js";
import { assistantToolCallTurn, toolResultTurn, assistantReplyTurn } from "../../session/conversation-turn.js";
export interface StepCommitArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prompt: BuiltPrompt;
  completion: CompletionResult;
  reasoning: string;
  admission: StepDispatchPlan;
  batchOutcome: BatchExecutionResult;
  stepDurationMs: number;
  progressNote: ToolCallPayload | null;
  trimmedBatchNotice: string | undefined;
  waveSplitNotice: string | undefined;
}

export function commitStepBatch(args: StepCommitArgs): StepOutcome {
  const { ctx, deps, prompt, completion, reasoning, batchOutcome, stepDurationMs, progressNote, waveSplitNotice } = args;
  const { calls, suppressed, unverified, unsourced, batchSize, progressNoteIndex } = args.admission;
  let { trimmedBatchNotice } = args;
  const modelMode = (completion.servedModelMode ?? deps.modelMode)?.mode;

  // Materialise per-call results in batch-index order. Cancelled tail
  // calls are folded into a synthetic error result so the transcript
  // and `applyStateEffects` stay in lockstep with `toolCalls.length`.
  const toolResults: CompressedToolResult[] = batchOutcome.results.map(
    (slot, idx): CompressedToolResult => {
      if (slot.compressed) return modelMode === "cloud" ? fullToolResult(slot.compressed) : slot.compressed;
      return compressToolResult({
        tool: slot.call.tool,
        status: "error",
        output: `cancelled before invocation (batch index ${idx})`,
        details: { cancelled: true },
      });
    },
  );
  // A reply delivered with claims nothing backs (the turn was already
  // told once, or this is the forced final step) is marked, so the trace
  // and the transcript say the check was never seen to run.
  // Same for a link no tool result held.
  if ((unverified.length > 0 || unsourced.length > 0) && suppressed === null) {
    const last = toolResults.length - 1;
    const reply = toolResults[last];
    if (reply !== undefined && reply.tool === "reply") {
      toolResults[last] = {
        ...reply,
        details: {
          ...reply.details,
          ...evidenceMarks(unverified, unsourced),
        },
      };
    }
  }

  // The transcript cut this step's prompt was built on travels with the
  // session so the next step holds it (`packConversation`).
  let workSession: SessionState = rememberConversationPackStart(
    {
      ...ctx.session,
      ...(prompt.cloudContext && !ctx.session.cloudContext ? { cloudContext: prompt.cloudContext } : {}),
      stepCount: ctx.session.stepCount + 1,
    },
    prompt.conversationPackStart,
  );

  // Per-failed-rare autoload, applied in batch-index order. Successful
  // rare calls feed `recordLoadedTool` via `details.toolLoaded` in
  // `applyStateEffects` below. A call held back behind an approval
  // barrier never ran, so its error says nothing about its arguments.
  for (let i = 0; i < toolResults.length; i += 1) {
    const result = toolResults[i]!;
    const call = calls[i]!;
    if (
      result.status === "error" &&
      result.details.notRun !== true &&
      getConfig().agent.autoExpandRareOnError &&
      isRareToolName(call.tool) &&
      !workSession.loadedTools.some((t) => t.name === call.tool)
    ) {
      const d = getToolDescriptorByName(call.tool);
      if (d && d.tier === "rare") {
        workSession = recordLoadedTool(
          workSession,
          {
            name: d.name,
            summary: d.summary,
            argsSchema: d.argsSchema,
            ...(d.examples && d.examples.length > 0
              ? { examples: d.examples }
              : {}),
            source: "auto",
          },
          modelMode === "cloud" ? Number.MAX_SAFE_INTEGER : getConfig().agent.loadedToolsCap,
        );
        deps.onEvent?.({
          type: "rare_tool_autoloaded",
          tool: call.tool,
          source: "auto",
          stepIndex: ctx.stepIndex,
        });
      }
    }
  }

  // The suppressed terminal joins the step as a call that never ran: its
  // error result is what the transcript, the trace and the loop see, so
  // the model reads on the next step that its reply was not delivered.
  if (suppressed !== null) {
    deps.onEvent?.({
      type: "tool_call_executed",
      result: suppressed.result,
      batchIndex: calls.length,
      batchSize,
    });
  }
  const stepCalls = suppressed !== null ? [...calls, suppressed.call] : calls;
  const stepResults =
    suppressed !== null ? [...toolResults, suppressed.result] : toolResults;

  // Apply state effects in batch-index order. `recordLatestResult` is
  // called on every result (last writer wins, deterministic). World
  // snapshot updates from multiple results collapse to last writer
  // by index.
  let nextSession: SessionState = workSession;
  for (let i = 0; i < stepResults.length; i += 1) {
    const result = stepResults[i]!;
    nextSession = recordLatestResult(nextSession, {
      tool: result.tool,
      status: result.status,
      summary: result.summary,
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
    nextSession = applyStateEffects(nextSession, result, modelMode);
  }

  // Terminal classification looks at the **last** call of the batch:
  // the validator guarantees a terminal verb can only appear at the
  // tail, and the executor enforces a barrier so the terminal call
  // runs after every other call. For solo steps `lastIdx === 0` and
  // the behaviour is identical to the legacy path. A suppressed
  // terminal never closes anything, so the last call that actually ran
  // decides instead (none ran ⇒ the step is not terminal).
  const lastIdx = calls.length - 1;
  const terminal: StepTerminal =
    lastIdx >= 0 &&
    (suppressed === null ||
      resourceClassFor(calls[lastIdx]!.tool) !== "terminal")
      ? classifyTerminal(calls[lastIdx]!, toolResults[lastIdx]!)
      : null;

  nextSession = appendBatchedTurns({
    state: nextSession,
    calls: stepCalls,
    results: stepResults,
    reasoning,
    terminal,
    modelMode,
    onEvent: deps.onEvent,
  });

  // The progress note lands after the step's tool pairs, as the reply it
  // was — flagged, so nothing reads it as the end of the macro-turn —
  // and the model is told once per turn why the turn did not close.
  let outcomeCalls = stepCalls;
  let outcomeResults = stepResults;
  if (progressNote !== null) {
    const noted = recordProgressNote({
      state: nextSession,
      note: progressNote,
      batchIndex: progressNoteIndex,
      batchSize,
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    });
    nextSession = noted.state;
    outcomeCalls = [...stepCalls, progressNote];
    outcomeResults = [...stepResults, noted.result];
    if (deps.progressNotes === undefined || !deps.progressNotes.noticed()) {
      deps.progressNotes?.markNoticed();
      const notice = formatProgressNoteNotice();
      trimmedBatchNotice =
        trimmedBatchNotice === undefined
          ? notice
          : `${trimmedBatchNotice}\n\n${notice}`;
    }
  }

  void stepDurationMs; // captured for future cross-call observability hooks
  if (batchOutcome.cancelled) {
    if (modelMode === "cloud") deps.commitSession?.(nextSession);
    throw new CancelledError("batch cancelled mid-execution");
  }
  return {
    toolCalls: outcomeCalls,
    toolResults: outcomeResults,
    completion,
    prompt,
    nextSession,
    terminal,
    loopSignals: batchOutcome.loopSignals,
    ...(trimmedBatchNotice !== undefined ? { trimmedBatchNotice } : {}),
    ...(waveSplitNotice !== undefined ? { waveSplitNotice } : {}),
    ...(progressNote !== null
      ? { progressNote: progressNoteText(progressNote) }
      : {}),
  };
}



/**
 * `reply` ends the current macro-turn but keeps the session alive.
 * `finish` ends the whole session. We also accept a legacy
 * `details.final === true` flag from custom tools that want to act as a
 * session terminator without hard-coding the tool name.
 */
export function classifyTerminal(
  toolCall: ToolCallPayload,
  toolResult: CompressedToolResult,
): StepTerminal {
  if (toolCall.tool === "reply") return "turn";
  if (toolCall.tool === "finish") return "session";
  const flag = toolResult.details?.final;
  if (flag === true) return "session";
  return null;
}


export interface AppendBatchedTurnsParams {
  modelMode?: "local" | "cloud";
  state: SessionState;
  calls: readonly ToolCallPayload[];
  results: readonly CompressedToolResult[];
  reasoning: string;
  terminal: StepTerminal;
  onEvent?: (event: StepEvent) => void;
}


/**
 * The `attachments` a `reply` result carries, or `[]`. Defensive on
 * shape: only a `string[]` of non-empty entries counts, so a hand-rolled
 * or legacy result without the field projects to "no attachments".
 */
export function readReplyAttachments(
  details: Record<string, unknown> | undefined,
): string[] {
  const raw = details?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}


/**
 * Project the executed step (single or batched) into the conversation
 * transcript. The terminal `reply` verb (`terminal === "turn"`) is
 * collapsed into a single `assistant_reply` turn — no separate
 * tool-call / tool-result pair — so the chat reads naturally. This
 * collapse works both for a solo `[reply]` step and for a batched
 * `[..., reply]` step: in the batched case, every non-terminal call
 * is emitted as the canonical `assistant_tool_call` + `tool_result`
 * pair first, then the tail `reply` collapses into `assistant_reply`
 * at the end (reasoning attaches to the first non-terminal pair, or
 * to the reply itself when there is no non-terminal portion).
 * `terminal === "session"` (`finish`) keeps the legacy tool-call /
 * tool-result projection — the agent loop interprets the `final`
 * flag to close the session without any additional transcript magic.
 *
 * Per-batch char cap: when the combined summary text would exceed
 * `agent.batchToolResultCharCap`, the results share it evenly before
 * being appended (`batch-summary-cap.ts`): none is erased, and each cut
 * one says how to get the rest. This keeps the conversation section
 * bounded under pathological large-batch outputs without losing the
 * call/result pairing.
 */
export function appendBatchedTurns(params: AppendBatchedTurnsParams): SessionState {
  const { state, calls, results, reasoning, terminal, onEvent } = params;

  // `reply` collapses into `assistant_reply` regardless of batch
  // size. For a batched step the terminal is guaranteed to be at the
  // tail (validator invariant), so we emit non-terminal pairs first
  // and then collapse the last call.
  if (terminal === "turn") {
    const terminalIdx = calls.length - 1;
    const terminalCall = calls[terminalIdx]!;
    const terminalResult = results[terminalIdx]!;
    const hasNonTerminal = terminalIdx > 0;
    let next = state;
    if (hasNonTerminal) {
      const renderedSummaries = params.modelMode === "cloud" ? results.slice(0, terminalIdx).map((r) => r.summary) : capBatchSummaries(
        results.slice(0, terminalIdx),
        calls.slice(0, terminalIdx),
        getConfig().agent.batchToolResultCharCap,
      );
      for (let i = 0; i < terminalIdx; i += 1) {
        const call = calls[i]!;
        const result = results[i]!;
        const cappedSummary = renderedSummaries[i]!;
        const cappedTruncated = cappedSummary !== result.summary;
        next = recordTurn(
          next,
          assistantToolCallTurn({
            tool: call.tool,
            args: call.args,
            ...(i === 0 && reasoning.length > 0 ? { reasoning } : {}),
          }),
        );
        next = recordTurn(
          next,
          toolResultTurn({
            tool: result.tool,
            status: result.status,
            summary: cappedSummary,
            ...(result.truncated || cappedTruncated ? { truncated: true } : {}),
            ...(result.approvals ? { approvals: result.approvals } : {}),
            ...readTurnField(result),
          }),
        );
      }
    }
    const text =
      typeof terminalCall.args?.text === "string" &&
      terminalCall.args.text.length > 0
        ? (terminalCall.args.text as string)
        : terminalResult.summary;
    // Attachments come from the tool *result*, not the call args: the
    // tool has already validated the paths exist and resolved them
    // against the working directory, so every consumer downstream gets
    // absolute paths it can open without repeating that work.
    const attachments = readReplyAttachments(terminalResult.details);
    onEvent?.({
      type: "assistant_reply",
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return recordTurn(
      next,
      assistantReplyTurn(text, {
        // Reasoning attaches to the first non-terminal pair when one
        // exists; otherwise the reply itself owns the <think> block.
        ...(!hasNonTerminal && reasoning.length > 0 ? { reasoning } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    );
  }

  const renderedSummaries = params.modelMode === "cloud" ? results.map((r) => r.summary) : capBatchSummaries(
    results,
    calls,
    getConfig().agent.batchToolResultCharCap,
  );

  let next = state;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const result = results[i]!;
    const cappedSummary = renderedSummaries[i]!;
    const cappedTruncated = cappedSummary !== result.summary;
    next = recordTurn(
      next,
      assistantToolCallTurn({
        tool: call.tool,
        args: call.args,
        ...(i === 0 && reasoning.length > 0 ? { reasoning } : {}),
      }),
    );
    next = recordTurn(
      next,
      toolResultTurn({
        tool: result.tool,
        status: result.status,
        summary: cappedSummary,
        ...(result.truncated || cappedTruncated ? { truncated: true } : {}),
        ...(result.approvals ? { approvals: result.approvals } : {}),
        ...readTurnField(result),
      }),
    );
  }
  return next;
}

/**
 * The `read` field of a result row: what an `os.fs.read` read, so the
 * prompt can show a repeat of it as a pointer while the first read is in
 * view (`findReadRepeats`). Taken from the result, so a row whose text
 * a batch cap cut still names the whole read; a pointer is only drawn
 * between rows whose stored texts match, so a cut row never stands for,
 * or is stood for by, a different cut of the same lines.
 */
function readTurnField(result: CompressedToolResult): {
  read?: ReadTurnIdentity;
} {
  const read = readTurnIdentity(result.tool, result);
  return read !== null ? { read } : {};
}


/**
 * Inspect well-known tool-result fields and fold them into the session
 * state. Tools communicate state updates through `details.skillLoaded`
 * (`skill.view`), `details.toolLoaded` (`tool.view`), and
 * `details.worldSnapshot` (for browser actions) so the step executor
 * stays generic and tools remain pure.
 */
export function applyStateEffects(
  session: SessionState,
  result: CompressedToolResult,
  modelMode?: "local" | "cloud",
): SessionState {
  let next = session;
  const details = result.details;
  if (details && typeof details === "object") {
    const toolLoaded = (details as Record<string, unknown>).toolLoaded;
    if (
      toolLoaded &&
      typeof toolLoaded === "object" &&
      typeof (toolLoaded as { name?: unknown }).name === "string" &&
      typeof (toolLoaded as { summary?: unknown }).summary === "string" &&
      typeof (toolLoaded as { argsSchema?: unknown }).argsSchema === "string" &&
      ((toolLoaded as { source?: unknown }).source === "explicit" ||
        (toolLoaded as { source?: unknown }).source === "auto")
    ) {
      const t = toolLoaded as {
        name: string;
        summary: string;
        argsSchema: string;
        examples?: string[];
        source: "explicit" | "auto";
      };
      next = recordLoadedTool(
        next,
        {
          name: t.name,
          summary: t.summary,
          argsSchema: t.argsSchema,
          ...(t.examples !== undefined && t.examples.length > 0
            ? { examples: t.examples }
            : {}),
          source: t.source,
        },
        modelMode === "cloud" ? Number.MAX_SAFE_INTEGER : getConfig().agent.loadedToolsCap,
      );
    }
    const loaded = (details as Record<string, unknown>).skillLoaded;
    if (
      loaded &&
      typeof loaded === "object" &&
      typeof (loaded as { name?: unknown }).name === "string" &&
      typeof (loaded as { version?: unknown }).version === "string" &&
      typeof (loaded as { body?: unknown }).body === "string"
    ) {
      const entry = loaded as { name: string; version: string; body: string };
      next = recordLoadedSkill(next, {
        name: entry.name,
        version: entry.version,
        body: entry.body,
        loadedAt: Date.now(),
      });
    }
    const snapshot = (details as Record<string, unknown>).worldSnapshot;
    if (
      snapshot &&
      typeof snapshot === "object" &&
      typeof (snapshot as { digest?: unknown }).digest === "string" &&
      typeof (snapshot as { text?: unknown }).text === "string"
    ) {
      const entry = snapshot as { digest: string; text: string; kind?: string };
      next = recordWorldSnapshot(next, {
        kind: entry.kind === "browser" ? "browser" : "browser",
        digest: entry.digest,
        text: entry.text,
        capturedAt: Date.now(),
      });
    }
  }
  return next;
}
