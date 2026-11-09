import {
  buildGoalContinuationMessage,
  buildGoalKickoffMessage,
  createGoalState,
  goalSpecOf,
  goalStatusReport,
  goalSummaryLine,
  readGoalState,
  resumeGoalState,
  setGoalStatus,
  statusLabel,
  withGoalState,
  GOAL_MAX_CHECKS,
  type GoalSpec,
  type GoalState,
} from "../../agent/goal/index.js";
import type { SessionState } from "../../session/index.js";
import type { GoalCommand } from "../commands/goal-command.js";

/**
 * What `/goal` does to the open chat (ATO-451). The orchestrator hands
 * in its session and side effects; this file holds the decisions, so
 * they are testable without a runtime.
 */
export interface GoalCommandContext {
  session: SessionState;
  /** A turn (and so maybe a goal run) is running on this session. */
  turnRunning: boolean;
  /** `runtime.controlGoal`: stop a running goal after its round. */
  controlGoal?: (sessionId: string, verb: "pause" | "clear") => boolean;
  /** Store the session with its new metadata and make it the open one. */
  save(session: SessionState): void;
  /** Send a message as the person would (starts the goal's rounds). */
  send(text: string): void;
  /** A system line in the chat. */
  say(text: string): void;
  /** Update the goal line under the chat. */
  show(goal: GoalState | null): void;
  now(): number;
}

export function runGoalCommand(command: GoalCommand, ctx: GoalCommandContext): void {
  const stored = readGoalState(ctx.session.metadata);
  const store = (goal: GoalState | null): void => {
    ctx.save({ ...ctx.session, metadata: withGoalState(ctx.session.metadata, goal) });
    ctx.show(goal);
  };
  switch (command.kind) {
    case "error":
      ctx.say(command.message);
      return;
    case "status":
      ctx.say(stored ? goalStatusReport(stored) : "no goal in this chat. Set one with /goal <criteria>");
      return;
    case "set": {
      if (ctx.turnRunning) {
        ctx.say("a turn is running: wait for it to end (or press Esc), then set the goal");
        return;
      }
      const goal = createGoalState(
        { criteria: command.criteria, checks: [...command.checks, ...(stored?.checks ?? [])] },
        ctx.now(),
      );
      store(goal);
      ctx.say(`goal set: ${goal.criteria.length} criteria, ${goal.checks.length} checks, up to ${goal.maxRounds} rounds`);
      ctx.send(buildGoalKickoffMessage(goal));
      return;
    }
    case "check_add":
    case "check_clear": {
      if (!stored) {
        ctx.say("set a goal first with /goal <criteria>; a `check: <cmd>` item adds a check inline");
        return;
      }
      if (ctx.turnRunning && stored.status === "active") {
        ctx.say("the goal is running: /goal pause, change the checks, then /goal resume");
        return;
      }
      const checks = command.kind === "check_clear"
        ? []
        : [...stored.checks.filter((c) => c !== command.command), command.command].slice(-GOAL_MAX_CHECKS);
      store({ ...stored, checks, updatedAt: ctx.now() });
      ctx.say(command.kind === "check_clear" ? "goal checks cleared" : `goal check added: ${command.command}`);
      return;
    }
    case "pause": {
      if (!stored || stored.status !== "active") {
        ctx.say(stored ? `the goal is not running (${statusLabel(stored.status)})` : "no goal to pause");
        return;
      }
      if (ctx.turnRunning && ctx.controlGoal?.(ctx.session.id, "pause")) {
        ctx.say("the goal will pause after the current round");
        return;
      }
      store(setGoalStatus(stored, "paused", ctx.now(), "paused by you"));
      ctx.say("goal paused. /goal resume continues it");
      return;
    }
    case "resume": {
      if (!stored) {
        ctx.say("no goal to resume");
        return;
      }
      if (stored.status === "complete") {
        ctx.say("the goal is already complete. Set a new one with /goal <criteria>");
        return;
      }
      if (ctx.turnRunning) {
        ctx.say("a turn is running: wait for it to end, then /goal resume");
        return;
      }
      const goal = resumeGoalState(stored, ctx.now());
      store(goal);
      ctx.send(goal.roundsUsed > 0 ? buildGoalContinuationMessage(goal, []) : buildGoalKickoffMessage(goal));
      return;
    }
    case "clear": {
      if (!stored) {
        ctx.say("no goal to clear");
        return;
      }
      if (ctx.turnRunning && stored.status === "active" && ctx.controlGoal?.(ctx.session.id, "clear")) {
        ctx.say("the goal will be cleared after the current round");
        ctx.show(null);
        return;
      }
      store(null);
      ctx.say("goal cleared");
      return;
    }
  }
}

/**
 * The goal options for the next turn: only an active goal drives rounds;
 * a paused, blocked or finished one leaves ordinary turns alone.
 */
export function activeGoalSpec(session: SessionState): GoalSpec | undefined {
  const goal = readGoalState(session.metadata);
  return goal?.status === "active" ? goalSpecOf(goal) : undefined;
}

/**
 * Turns goal state changes into chat lines: one after every evaluation
 * and one when the goal stops, so the person can follow an overnight
 * run in the transcript as well as on the goal line.
 */
export function createGoalProgressReporter(
  say: (text: string) => void,
  show: (goal: GoalState) => void,
): (goal: GoalState) => void {
  let lastVerdictAt: number | undefined;
  let lastStatus: GoalState["status"] = "active";
  return (goal) => {
    show(goal);
    if (goal.lastVerdict && goal.lastVerdict.at !== lastVerdictAt) {
      lastVerdictAt = goal.lastVerdict.at;
      if (goal.status === "active") say(`goal round ${goal.lastVerdict.round}: ${goal.lastVerdict.summary}`);
    }
    if (goal.status !== lastStatus) {
      lastStatus = goal.status;
      if (goal.status !== "active") {
        say(`${goalSummaryLine(goal)}${goal.statusReason ? `\n  ${goal.statusReason}` : ""}`);
      }
    }
  };
}
