import type { ApprovalCategory } from "../../approval/approval-level.js";
import type { ToolRole } from "../tool-roles.js";

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
 * instruction, not the operator's history, and may not drive the
 * operator's screen. Every read tool, browser,
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
  // A worker has no screen of its own to watch and nobody approves its
  // input: the operator's desktop stays with the orchestrator's turn.
  "os.screen.capture",
  "os.screen.click",
  "os.screen.type",
  "os.screen.key",
  "os.screen.point",
  // The live checklist is the operator's view of the orchestrator's
  // work (ATO-486); a worker's own list would reach nobody.
  "plan.update",
]);

/** `RunTurnOptions.toolFilter` for a worker turn. */
export function isWorkerVisibleTool(name: string): boolean {
  return !WORKER_EXCLUDED_TOOLS.has(name);
}

/**
 * `RunTurnOptions.toolRole` for a worker turn: a worker builds. The role
 * (see `tool-roles.ts`) decides what is described in full, put on the
 * native wire and admitted by the grammar — files, shell, `verify.*`,
 * the discovery tools, MCP tools, `reply`; everything else costs a
 * `tool.view` first. The exclusion list above is the harder line
 * underneath it: a hidden tool cannot be loaded back, a merely
 * out-of-role one can.
 */
export const WORKER_TOOL_ROLE: ToolRole = "builder";

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
  "it cannot run the action itself. " +
  "A browser step that submits, publishes, deletes, pays or enters a password needs the user: " +
  "report that step and do not retry it another way.";

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

/**
 * The stable substring of `FUSION_WORKER_OPERATOR_ONLY_REFUSED`: the
 * result classifier keys a note to the orchestrator off it.
 */
export const FUSION_WORKER_OPERATOR_ONLY_MARKER =
  "only the operator can approve it, and no fan-out can authorise it";

/**
 * The refusal for a step no fan-out can authorise, whatever directory
 * it names: a dangerous shell command (`shell_dangerous`), the agent's
 * own trust config or secret files (`trust_config`, `state_secret`), a
 * mail, a password or a payment. The general refusal tells the worker
 * to name the path so the task can be sent out again with it; for these
 * that is a loop — the operator is asked about a wider fan-out, says
 * yes, and the worker is refused again. So this one says to stop and
 * hand the step to the operator. It keeps `FUSION_WORKER_APPROVAL_MARKER`
 * so the task still comes back `needs_orchestrator`.
 */
export const FUSION_WORKER_OPERATOR_ONLY_REFUSED =
  `this step ${FUSION_WORKER_APPROVAL_MARKER}, and ${FUSION_WORKER_OPERATOR_ONLY_MARKER}: ` +
  "a dangerous command (rm -rf, git reset --hard, a force push, sudo), a read or change of " +
  "the agent's own config or secret files, a mail, a password or a payment. " +
  "Do not retry it or try another way to do the same thing. In your reply, name the exact " +
  "command or file and report it to the orchestrator: re-sending the task will not help, " +
  "only the user can run or approve it.";

/** Categories a fan-out's directory never covers (see above). */
const OPERATOR_ONLY_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set([
  "shell_dangerous",
  "trust_config",
  "state_secret",
  "email",
  "browser_secret",
]);

/**
 * `SessionApprovalPolicy.reasonFor` for a worker: the operator-only
 * refusal for a step no fan-out can authorise, else `undefined` (the
 * general `FUSION_WORKER_APPROVAL_REFUSED`).
 */
export function workerRefusalFor(request: {
  category: ApprovalCategory;
}): string | undefined {
  return OPERATOR_ONLY_CATEGORIES.has(request.category)
    ? FUSION_WORKER_OPERATOR_ONLY_REFUSED
    : undefined;
}
