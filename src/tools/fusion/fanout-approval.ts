import { resolve as resolvePath } from "node:path";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  ApprovalDeniedError,
  requireApproval,
} from "../../approval/dangerous-tool.js";
import { isInside } from "../../approval/fanout-scope.js";
import {
  isAutoApprovedAt,
  type ApprovalLevel,
} from "../../approval/approval-level.js";
import type { DelegateTask } from "./delegate-args.js";
import { resolveFanoutScope } from "./fanout-paths.js";
import type { WorkerRunnerCoreDeps } from "./worker-runner-core.js";

/**
 * The write question a fan-out asks before any worker starts, shared by
 * `fusion.delegate` and `subagent.run` (ATO-2446): the scope the tasks'
 * `files` give, the refusal for the agent's own state directory, and one
 * `fusion_fanout` prompt for the whole call. Each tool words its own
 * refusals and its own prompt reason; the steps and their order are here.
 */

/**
 * The scope directories that sit inside the agent's state directory,
 * or the state directory itself. A scope that merely contains it (the
 * home directory, say) is not refused here: the per-file trust-surface
 * guard already keeps config.json, .env, rules, hooks and plugins out
 * of any fan-out grant.
 */
export function scopeInsideStateDir(
  writeScope: readonly string[],
  stateDir: string | undefined,
): string[] {
  if (stateDir === undefined || stateDir.length === 0) return [];
  const root = resolvePath(stateDir);
  return writeScope.filter((dir) => isInside(root, resolvePath(dir)));
}

/**
 * Whether the fan-out question is left to the standing level instead of
 * asked (ATO-1689). In auto mode (level 2, workspace writes stop asking)
 * a normal chat writes inside its folder unasked, and a fan-out whose
 * every directory sits inside that same folder hands its workers nothing
 * more than that, so asking about it is a prompt a normal chat would not
 * show.
 *
 * Only on the levels where workspace writes are silent but the fan-out
 * itself is not (2 and 3). From level 4 the ladder already silences the
 * fan-out with its full authority. A directory outside the folder is a
 * write a normal auto-mode chat would ask about, so the question stays.
 *
 * Returning true never widens what a worker may do: the caller then
 * hands the workers no fan-out scope (`scopeApproved: false`), so every
 * worker step goes to the gate under the standing level, like the
 * chat's own. Shell commands, which the fan-out's yes would cover, are
 * asked about at level 2, and a worker's refuse policy hands them back
 * to the orchestrator.
 */
export function fanoutQuietUnderLevel(
  level: ApprovalLevel,
  writeScope: readonly string[],
  workingDir: string,
): boolean {
  if (isAutoApprovedAt(level, "fusion_fanout")) return false;
  if (!isAutoApprovedAt(level, "fs_write_workspace")) return false;
  if (writeScope.length === 0) return false;
  const root = resolvePath(workingDir);
  return writeScope.every((dir) => isInside(root, resolvePath(dir)));
}

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

export interface FanoutWriteQuestion {
  /** The tool asking: the prompt's `tool`, and what a rule matches on. */
  tool: string;
  sessionId: string;
  turnId: string | undefined;
  tasks: readonly DelegateTask[];
  workingDir: string;
  /** The agent's own state directory: no scope may lie inside it. */
  agentStateDir: string | undefined;
  approvals: WorkerRunnerCoreDeps["approvals"];
  approvalRequired: boolean;
  signal: AbortSignal;
  /**
   * The prompt's reason line for this scope. `quiet` is true for the
   * workspace-write form of the quiet branch, false for the fan-out
   * question itself.
   */
  reason: (writeScope: readonly string[], quiet: boolean) => string;
  /**
   * Drop the gate's turn state unless it is tied to this very turn
   * (`subagent.run`, ATO-1759): the gate clears it at turn start only
   * for a Fusion turn. Absent: only enter the turn, as Fusion does.
   */
  clearStaleTurnState?: boolean;
  /**
   * On a yes from a person shown this question, forget the files they
   * declined in its directories (`fusion.delegate`). Absent: kept.
   */
  renewDeclinedOnYes?: boolean;
  /**
   * The caller's own conditions allow the quiet branch (ATO-1689), as
   * `fusion.delegate` decides it from its contract. Absent or false: the
   * question is always asked.
   */
  allowQuiet?: boolean;
}

export type FanoutWriteAnswer =
  | {
      ok: true;
      writeScope: string[];
      /**
       * False after a quiet fan-out: nobody approved the scope, so the
       * workers get none (`scopeApproved: false`) and it is not granted
       * for the turn.
       */
      workersHoldScope: boolean;
    }
  | { ok: false; kind: "agent-state-dir"; writeScope: string[]; intoState: string[] }
  | {
      ok: false;
      kind: "denied";
      /** The user's own no, or a repeat of one declined earlier this turn. */
      byUser: boolean;
      message: string;
    };

/**
 * One question for the whole fan-out, asked before a single worker
 * starts. A worker has no operator to ask, so the operator is asked here
 * instead, once, with the task list and the directories in front of them.
 *
 * A turn is one job: the answer stands for the rest of the turn while
 * later fan-outs stay inside the directories it named, except after the
 * user declined a file in them this turn, when the question is asked
 * again. The turn state is tied to the turn (ATO-1759), so the two tools
 * read each other's answer within one turn.
 */
export async function askFanoutWrite(
  q: FanoutWriteQuestion,
): Promise<FanoutWriteAnswer> {
  const writeScope = resolveFanoutScope(q.tasks, q.workingDir);
  // Never into the agent's own state directory (ATO-1267).
  const intoState = scopeInsideStateDir(writeScope, q.agentStateDir);
  if (intoState.length > 0) {
    return { ok: false, kind: "agent-state-dir", writeScope, intoState };
  }
  const scopes = q.approvals.fanoutScopes;
  if (
    q.clearStaleTurnState === true &&
    (q.turnId === undefined ||
      !(scopes?.turnStateIsFrom(q.sessionId, q.turnId) ?? false))
  ) {
    scopes?.clearTurnGrant(q.sessionId);
  }
  if (q.turnId !== undefined) scopes?.enterTurn(q.sessionId, q.turnId);
  const declinedInScope =
    q.approvals.hasDeclinedUnder?.(q.sessionId, writeScope) ?? false;
  const alreadyApproved =
    !declinedInScope &&
    (scopes?.turnGrantCovers(q.sessionId, writeScope) ?? false);
  // Auto mode (ATO-1689): a fan-out that stays inside the chat's folder
  // is no question at a level where writes there are silent. It still
  // goes through the gate as the workspace write it is, so a saved deny
  // or ask rule on the tool keeps its say. Not after a worker was refused
  // a command under an earlier quiet fan-out this turn, nor when the chat
  // read outside content.
  const approvalLevel =
    q.allowQuiet === true ? q.approvals.getLevel?.() : undefined;
  const quiet =
    q.allowQuiet === true &&
    q.approvalRequired &&
    !alreadyApproved &&
    !declinedInScope &&
    approvalLevel !== undefined &&
    fanoutQuietUnderLevel(approvalLevel, writeScope, q.workingDir) &&
    !(scopes?.commandRefusedThisTurn(q.sessionId) ?? false) &&
    !(q.approvals.holdsForOutsideContent?.(q.sessionId, "http") ?? false);
  const gate = {
    approvals: q.approvals as ApprovalGate,
    approvalRequired: q.approvalRequired,
  };
  try {
    if (quiet) {
      await requireApproval(
        gate,
        {
          sessionId: q.sessionId,
          tool: q.tool,
          category: "fs_write_workspace",
          reason: q.reason(writeScope, true),
          preview: describeFanoutPreview(q.tasks, writeScope),
          affectedResources: [...writeScope],
        },
        q.signal,
      );
    } else if (!alreadyApproved) {
      // A yes from a person who was shown this fan-out is their newer
      // answer for the files they declined in its directories; one the
      // level gave is not, and those files stay declined.
      const asksPerson =
        q.renewDeclinedOnYes === true &&
        declinedInScope &&
        q.approvalRequired &&
        (q.approvals.wouldPrompt?.(q.sessionId, "fusion_fanout", {
          tool: q.tool,
          affectedResources: [...writeScope],
        }) ??
          false);
      await requireApproval(
        gate,
        {
          sessionId: q.sessionId,
          tool: q.tool,
          category: "fusion_fanout",
          reason: q.reason(writeScope, false),
          preview: describeFanoutPreview(q.tasks, writeScope),
          affectedResources: [...writeScope],
        },
        q.signal,
      );
      if (asksPerson) {
        q.approvals.forgetDeclinedUnder?.(q.sessionId, writeScope);
      }
    }
    // The level's yes is not a person's: it is not remembered for the
    // turn, so a later fan-out reaching outside the folder still asks.
    if (!quiet) scopes?.grantForTurn(q.sessionId, writeScope);
  } catch (err) {
    const byUser =
      err instanceof ApprovalDeniedError && (err.byUser || err.declinedEarlier);
    return {
      ok: false,
      kind: "denied",
      byUser,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, writeScope, workersHoldScope: !quiet };
}
