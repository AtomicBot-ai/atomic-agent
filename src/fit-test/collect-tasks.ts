/**
 * The user's last N tasks, read from their own chats, as a fit-test set
 * (ATO-1089).
 *
 * A task is one macro-turn: a user message, the tool calls the agent
 * made for it, and the reply that closed it (`isFinalReplyTurn`). Left
 * out: turns the user stopped, turns that never got a reply, slash
 * commands, repeats of the same prompt, and any task whose run sent
 * something outside the machine (`isOutboundCall`). Prompts and
 * reference replies go through the error scrubber's secret masking, so
 * a key pasted into a chat does not land in the task file.
 */
import { createHash } from "node:crypto";
import type { ApprovalCategory } from "../approval/index.js";
import {
  maskSecrets,
  type KnownSecret,
} from "../error-reporting/secret-detector.js";
import {
  isFinalReplyTurn,
  isStoppedTurnMarker,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";
import {
  FIT_TASK_SET_KIND,
  FIT_TASK_SET_VERSION,
  rubricForTask,
  type FitTask,
  type FitTaskSet,
} from "./fit-task.js";
import { isOutboundCall, type ToolCallFacts } from "./outbound-calls.js";

/** Tools that mark a task as coding work rather than a general one. */
const CODING_TOOLS = /^os\.fs\.(?:write|edit|patch)$|^os\.git\./;

/** Head-room over the original run's tool calls for the replay's step cap. */
const MIN_MAX_STEPS = 8;

export interface CollectTasksOptions {
  /** How many tasks to keep, newest first. */
  last: number;
  /** Exact secret values to mask besides the shape rules (the agent's own keys). */
  knownSecrets?: readonly KnownSecret[];
  /** For `createdAt`; tests pin it. */
  now?: () => Date;
}

/** Why candidate tasks were left out, by count. */
export interface CollectSkips {
  outbound: number;
  stopped: number;
  unanswered: number;
  command: number;
  duplicate: number;
}

export interface CollectTasksResult {
  set: FitTaskSet;
  skipped: CollectSkips;
}

interface Candidate {
  sessionId: string;
  at: number;
  prompt: string;
  calls: ToolCallFacts[];
  reply: string;
}

type Outcome = Candidate | keyof Pick<CollectSkips, "outbound" | "stopped" | "unanswered" | "command">;

/** Walk one session's turns into finished macro-turns and skip reasons. */
function sessionOutcomes(session: SessionState): Outcome[] {
  const out: Outcome[] = [];
  let open: { at: number; prompt: string; calls: ToolCallFacts[] } | null = null;
  const turns: readonly ConversationTurn[] = session.turns;
  for (const turn of turns) {
    if (turn.kind === "user") {
      if (turn.steered === true && open !== null) {
        open.prompt = `${open.prompt}\n\n${turn.text}`;
        continue;
      }
      if (open !== null) out.push("unanswered");
      open = { at: turn.at, prompt: turn.text, calls: [] };
      continue;
    }
    if (open === null) continue;
    if (turn.kind === "assistant_tool_call") {
      open.calls.push({ tool: turn.tool, args: turn.args });
      continue;
    }
    if (turn.kind === "tool_result") {
      const call = [...open.calls].reverse().find((c) => c.tool === turn.tool && c.approvalCategories === undefined);
      const categories: ApprovalCategory[] = (turn.approvals ?? []).map((a) => a.category);
      if (call !== undefined && categories.length > 0) call.approvalCategories = categories;
      continue;
    }
    if (!isFinalReplyTurn(turn)) continue;
    const finished = open;
    open = null;
    if (isStoppedTurnMarker(turn)) out.push("stopped");
    else if (finished.prompt.trim().startsWith("/")) out.push("command");
    else if (finished.prompt.trim() === "" || turn.text.trim() === "") out.push("unanswered");
    else if (finished.calls.some(isOutboundCall)) out.push("outbound");
    else out.push({ sessionId: session.id, at: finished.at, prompt: finished.prompt, calls: finished.calls, reply: turn.text });
  }
  return out;
}

function taskId(candidate: Candidate): string {
  const digest = createHash("sha256").update(`${candidate.sessionId}\n${candidate.at}`).digest("hex");
  return `fit-${digest.slice(0, 10)}`;
}

function taskName(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function toTask(candidate: Candidate, known: readonly KnownSecret[]): FitTask {
  const toolsUsed = [...new Set(candidate.calls.map((c) => c.tool))];
  const referenceReply = maskSecrets(candidate.reply, known);
  return {
    id: taskId(candidate),
    name: taskName(maskSecrets(candidate.prompt, known)),
    category: toolsUsed.some((t) => CODING_TOOLS.test(t)) ? "coding" : "os",
    prompt: maskSecrets(candidate.prompt, known),
    maxSteps: Math.max(MIN_MAX_STEPS, candidate.calls.length * 2),
    expectations: [{ kind: "judge", rubric: rubricForTask(referenceReply) }],
    source: { sessionId: candidate.sessionId, at: candidate.at, toolsUsed, referenceReply },
  };
}

/**
 * The newest `options.last` tasks across `sessions`, oldest first in the
 * returned set. Pure: the caller reads the sessions.
 */
export function collectUserTasks(
  sessions: readonly SessionState[],
  options: CollectTasksOptions,
): CollectTasksResult {
  const skipped: CollectSkips = { outbound: 0, stopped: 0, unanswered: 0, command: 0, duplicate: 0 };
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    for (const outcome of sessionOutcomes(session)) {
      if (typeof outcome === "string") skipped[outcome] += 1;
      else candidates.push(outcome);
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (kept.length >= options.last) break;
    const key = candidate.prompt.trim().toLowerCase();
    if (seen.has(key)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(key);
    kept.push(candidate);
  }
  kept.reverse();
  const known = options.knownSecrets ?? [];
  return {
    set: {
      kind: FIT_TASK_SET_KIND,
      version: FIT_TASK_SET_VERSION,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      tasks: kept.map((c) => toTask(c, known)),
    },
    skipped,
  };
}
