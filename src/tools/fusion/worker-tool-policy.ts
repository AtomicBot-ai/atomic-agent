/**
 * What a fusion worker may and may not do.
 *
 * A worker is a local-model turn the cloud orchestrator fans a subtask
 * out to. It should do the work — read, run, browse, edit — and hand a
 * result back; it should not reshape the process around it. So it may
 * not delegate further (one fan-out level keeps the cost model legible
 * and the process bounded), may not end the operator's session, may not
 * file durable tasks the operator never asked for, and may not write
 * long-term memory, because its context is the orchestrator's
 * instruction, not the operator's history. Every read tool, browser,
 * os, skill and MCP tool stays visible.
 *
 * `fusion.delegate` is listed before it exists: PR 5 registers it, and
 * the exclusion must already hold the day it lands.
 *
 * Reach of the filter: it removes a descriptor from the prompt catalog
 * on every transport and from the native `tools` payload for every tool
 * but the two terminal ones — `descriptorsToOpenAiTools` appends `reply`
 * and `finish` unconditionally, and the GBNF grammar is built once per
 * runtime, not per turn. So `finish` is hidden from a worker's catalog,
 * not made uncallable; a worker that calls it anyway only ends its own
 * throwaway session, which the orchestrator reads the same way as a
 * reply. A hard per-turn deny lives in the registry, not here.
 */
export const WORKER_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "fusion.delegate",
  "finish",
  "tasks.schedule",
  "tasks.cron",
  "tasks.cancel",
  "memory.profile.set",
  "memory.profile.remove",
  "memory.notes.store",
  "memory.notes.forget",
]);

/** `RunTurnOptions.toolFilter` for a worker turn. */
export function isWorkerVisibleTool(name: string): boolean {
  return !WORKER_EXCLUDED_TOOLS.has(name);
}

/**
 * Reason a worker's approval-gated call is refused instead of prompting.
 * A worker has no operator at the other end of a prompt — the TUI is
 * showing the orchestrator's session — so the tool result tells the
 * model to hand the exact action back up rather than park the turn on a
 * question nobody will answer.
 *
 * "Back up" no longer means "the orchestrator does it". The orchestrator
 * is refused every mutating tool for the whole turn, so the only thing
 * it can do with a blocked path is name it in the next fan-out, where
 * the operator is asked to widen the scope. The wording says so, because
 * a worker that reports "the orchestrator must run this" is describing a
 * step that will never happen.
 */
export const FUSION_WORKER_APPROVAL_REFUSED =
  "this step needs operator approval, which a worker cannot request. " +
  "It is outside the directories this fan-out was authorised for. Stop and, in your reply, " +
  "name the exact path so the orchestrator can send the task out again with that path in `files` — " +
  "it cannot run the action itself.";

/**
 * The stable substring of the refusal that survives rewording of the
 * surrounding sentence. Two consumers key off it — the worker brief
 * (which names it so the model recognises the result) and the result
 * classifier (which turns a refusal into `needs_orchestrator`) — and
 * both would fail *silently* if the text drifted, so it is a constant
 * with a test pinning it against `FUSION_WORKER_APPROVAL_REFUSED`
 * rather than a literal copied into each call site.
 */
export const FUSION_WORKER_APPROVAL_MARKER =
  "needs operator approval, which a worker cannot request";
