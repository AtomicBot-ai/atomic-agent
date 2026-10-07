import type { StepContext, StepDependencies } from "./step-contract.js";
import type { ToolCallBatch, ToolCallPayload } from "../../llm/grammar/tool-call-grammar.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { StepBatchPolicy } from "./step-batch-policy.js";
import { resourceClassFor } from "../tool-resource-class.js";
import type { CheckClaim } from "../policies/claim-evidence.js";
import type { UnsourcedLink } from "../policies/link-evidence.js";
import { unverifiedClaims, turnToolCalls, formatUnverifiedClaimNotice, formatUnverifiedClaimRefusal } from "../policies/claim-evidence.js";
import { extractLinks, unsourcedLinks, linkSources, formatUnsourcedLinkNotice, formatUnsourcedLinkRefusal } from "../policies/link-evidence.js";
import { logTextPreview } from "./step-parsing.js";
import { resolveToolName } from "../tool-name-resolution.js";
import { ToolExecutionError } from "../../llm/index.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { FabricatedToolTranscript } from "../../llm/index.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
export function prepareStepDispatch(
  ctx: StepContext,
  deps: StepDependencies,
  batch: ToolCallBatch,
  completion: CompletionResult,
  policy: StepBatchPolicy,
) {
  const progressNote = policy.progressNote;

  // A completion that wrote tool calls and their results out as TEXT —
  // continuing the `assistant_tool_call:` / `tool_result[...]` lines the
  // conversation section is rendered in — did none of that work. Its
  // terminal (`reply` / `finish`) reports invented results as done, so it
  // is not accepted; genuine non-terminal calls from the same completion
  // still run, and the model is told on the next step why the turn did
  // not close. A completion the stream consumer already cut short for
  // this reason is the same case, reached before the provider's limit.
  const fabricated = policy.fabricationOf(completion);
  let calls = batch.calls;
  let suppressedTerminal: ToolCallPayload | null = null;
  if (fabricated !== null) {
    const notice = formatFabricatedTranscriptNotice(fabricated);
    policy.appendTrimNotice(notice);
    const last = calls[calls.length - 1];
    if (last !== undefined && resourceClassFor(last.tool) === "terminal") {
      suppressedTerminal = last;
      calls = calls.slice(0, -1);
    }
    deps.logger?.warn("completion wrote tool calls as plain text", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      textCalls: fabricated.calls,
      textResults: fabricated.results,
      suppressedTerminal: suppressedTerminal?.tool ?? null,
      nativeCallsRun: calls.map((call) => call.tool),
      streamAborted: completion.earlyStop?.reason === "fabricated_transcript",
    });
  }
  // A `reply` that claims a check ran — "node --check", "tests pass",
  // "verified" — with no matching call this turn is held back once, the
  // same way an invented transcript is: the model gets a notice and one
  // more step to run the check or drop the claim. The forced final step
  // is exempt (it exists so a turn is never cut off without a summary),
  // and the second time the claim is delivered and marked in the trace.
  //
  // A `reply` link that no tool result this turn holds, on a host those
  // results did link to — a search hit with a slug word dropped — is
  // held the same way, once per turn (`link-evidence.ts`). Both checks
  // read the same reply; when both fire on one step they share the one
  // held reply and the notice names both.
  let unverified: CheckClaim[] = [];
  let unsourced: UnsourcedLink[] = [];
  let heldRefusal: string | null = null;
  const tail = calls[calls.length - 1];
  const replyText =
    suppressedTerminal === null &&
    tail !== undefined &&
    tail.tool === "reply" &&
    typeof tail.args?.text === "string"
      ? tail.args.text
      : null;
  if (replyText !== null && deps.claimEvidence !== undefined) {
    unverified = unverifiedClaims(replyText, [
      ...turnToolCalls(ctx.session.turns),
      ...calls
        .slice(0, -1)
        .map((call) => ({ tool: call.tool, args: call.args ?? {} })),
    ]);
  }
  if (
    replyText !== null &&
    deps.linkEvidence !== undefined &&
    extractLinks(replyText).length > 0
  ) {
    // The reply's own batch can only hold bookkeeping here (a reply
    // batched with work became a progress note above), so the
    // transcript's results are every result the reply could quote. The
    // open page's snapshot is shown to the model too, so its links count
    // as known. A reply with no link skips the transcript scan.
    const world = ctx.session.worldSnapshot?.text;
    unsourced = unsourcedLinks(
      replyText,
      linkSources(ctx.session.turns, world ? [world] : []),
    );
  }
  if (tail !== undefined && ctx.terminalOnly !== true) {
    const notices: string[] = [];
    const refusals: string[] = [];
    if (unverified.length > 0 && deps.claimEvidence?.noticed() === false) {
      deps.claimEvidence.markNoticed();
      notices.push(formatUnverifiedClaimNotice(unverified));
      refusals.push(formatUnverifiedClaimRefusal(unverified));
      deps.logger?.warn("reply claims a check that did not run; held once", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        claims: unverified.map((claim) => claim.text),
      });
    }
    if (unsourced.length > 0 && deps.linkEvidence?.noticed() === false) {
      deps.linkEvidence.markNoticed();
      notices.push(formatUnsourcedLinkNotice(unsourced));
      refusals.push(formatUnsourcedLinkRefusal(unsourced));
      deps.logger?.warn("reply links a URL no tool result holds; held once", {
        sessionId: ctx.session.id,
        stepIndex: ctx.stepIndex,
        linkCount: unsourced.length,
        links: unsourced
          .slice(0, LOG_LINKS_MAX)
          .map((link) => logTextPreview(link.url, LOG_LINK_CHARS)),
      });
    }
    if (notices.length > 0) {
      const notice = notices.join("\n\n");
      policy.appendTrimNotice(notice);
      heldRefusal = refusals.join("\n");
      suppressedTerminal = tail;
      calls = calls.slice(0, -1);
    }
  }
  const batchSize =
    calls.length +
    (suppressedTerminal !== null ? 1 : 0) +
    (progressNote !== null ? 1 : 0);

  // Registry membership: surfaces as `ToolExecutionError` (category
  // `tool`) instead of `BatchValidationError`. A missing tool is a
  // bootstrap-time configuration mismatch, not a transient grammar
  // failure — replaying the prompt would not change the registry.
  for (const call of calls) {
    if (deps.registry.has(call.tool)) continue;
    // A near miss on the separator is not a missing tool. Qualified
    // names travel over the OpenAI wire as `__` and a model writing the
    // escaped form from memory lands on `fusion_delegate` — every
    // character right, one underscore short. That ended a whole turn in
    // a real session, twice in a row. Resolve the obvious forms before
    // treating the name as unknown; anything that still does not
    // resolve throws exactly as it did.
    const resolved = resolveToolName(call.tool, deps.registry);
    if (resolved === null) {
      throw new ToolExecutionError(
        call.tool,
        `tool not registered in this agent: ${call.tool}`,
      );
    }
    deps.logger?.debug?.("tool name resolved to its registered form", {
      emitted: call.tool,
      resolved,
    });
    call.tool = resolved;
  }

  // Emit one `tool_call_parsed` per call. Single-call steps preserve the
  // legacy ordering (parsed → executed → next event) one-for-one;
  // batched steps emit all parsed events first, then execution-order
  // results. Consumers correlate via `batchIndex` / `batchSize`.
  for (let i = 0; i < calls.length; i += 1) {
    deps.onEvent?.({
      type: "tool_call_parsed",
      call: calls[i]!,
      batchIndex: i,
      batchSize,
    });
  }
  const suppressed =
    suppressedTerminal !== null && fabricated !== null
      ? suppressedTerminalRecord(suppressedTerminal, fabricated)
      : suppressedTerminal !== null && heldRefusal !== null
        ? {
            call: suppressedTerminal,
            result: compressToolResult({
              tool: suppressedTerminal.tool,
              status: "error",
              output: heldRefusal,
              details: {
                notDelivered: true,
                ...evidenceMarks(unverified, unsourced),
              },
            }),
          }
        : null;
  if (suppressed !== null) {
    deps.onEvent?.({
      type: "tool_call_parsed",
      call: suppressed.call,
      batchIndex: calls.length,
      batchSize,
    });
  }
  // The note is the last call of the step's events: parsed now, with
  // the rest, and answered after the work ran (`recordProgressNote`).
  const progressNoteIndex = calls.length + (suppressed !== null ? 1 : 0);
  if (progressNote !== null) {
    deps.onEvent?.({
      type: "tool_call_parsed",
      call: progressNote,
      batchIndex: progressNoteIndex,
      batchSize,
    });
  }
  return { calls, suppressed, unverified, unsourced, batchSize, progressNoteIndex };
}

export type StepDispatchPlan = ReturnType<typeof prepareStepDispatch>;



/**
 * The next-step notice for a completion that wrote tool calls as text.
 * Blunt on purpose: the model believes that work is done.
 */
export function formatFabricatedTranscriptNotice(
  fabricated: FabricatedToolTranscript,
): string {
  const count = Math.max(fabricated.calls, fabricated.results);
  const noun = count === 1 ? "tool call" : "tool calls";
  const outcome =
    fabricated.results > 0
      ? "None of them ran and their results were invented."
      : "None of them ran.";
  return `Your last response contained ${count} ${noun} written as plain text. ${outcome} Call tools natively — nothing is done until a real tool result comes back.`;
}


/** Longest string argument a suppressed terminal keeps in the transcript. */
export const SUPPRESSED_ARG_PREVIEW_CHARS = 400;


/**
 * The call/result pair that stands in for a `reply` / `finish` that was
 * not accepted. The tool never runs. String arguments are clipped: when
 * the reply was synthesised from the text itself, its `text` IS the
 * fabricated transcript, and replaying 80k characters of invented tool
 * results into the next prompt would teach the pattern again.
 */
export function suppressedTerminalRecord(
  call: ToolCallPayload,
  fabricated: FabricatedToolTranscript,
): { call: ToolCallPayload; result: CompressedToolResult } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.args ?? {})) {
    args[key] =
      typeof value === "string" && value.length > SUPPRESSED_ARG_PREVIEW_CHARS
        ? `${value.slice(0, SUPPRESSED_ARG_PREVIEW_CHARS)} … [${value.length - SUPPRESSED_ARG_PREVIEW_CHARS} more chars not delivered]`
        : value;
  }
  const count = Math.max(fabricated.calls, fabricated.results);
  return {
    call: { ...call, args },
    result: compressToolResult({
      tool: call.tool,
      status: "error",
      output: `not delivered: the same response wrote ${count} tool call${count === 1 ? "" : "s"} as plain text instead of calling ${count === 1 ? "it" : "them"}, so the work it reports never happened. Do the work with real tool calls first.`,
      details: {
        notDelivered: true,
        textToolCalls: fabricated.calls,
        textToolResults: fabricated.results,
      },
    }),
  };
}

/** A held reply's links in its log line: this many, each cut to this length. */
export const LOG_LINKS_MAX = 5;

export const LOG_LINK_CHARS = 200;


/**
 * The trace marks a reply carries when a check found something: the
 * claims nothing backed (`unverifiedClaims`) and the links no tool
 * result held (`unsourcedLinks`). A key is present only when it has
 * entries.
 */
export function evidenceMarks(
  unverified: readonly CheckClaim[],
  unsourced: readonly UnsourcedLink[],
): Record<string, string[]> {
  return {
    ...(unverified.length > 0
      ? { unverifiedClaims: unverified.map((claim) => claim.text) }
      : {}),
    ...(unsourced.length > 0
      ? { unsourcedLinks: unsourced.map((link) => link.url) }
      : {}),
  };
}
