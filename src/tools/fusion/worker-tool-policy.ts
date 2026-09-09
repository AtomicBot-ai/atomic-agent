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
 */
export const FUSION_WORKER_APPROVAL_REFUSED =
  "this step needs operator approval, which a worker cannot request. " +
  "Stop and, in your reply, state exactly what must be run or written so the orchestrator can do it.";
