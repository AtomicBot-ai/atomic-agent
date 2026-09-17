import type { ConversationTurn } from "../../session/conversation-turn.js";
import { REQUEST_FOLLOW_UP_MARKER } from "../../prompt/request-section.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  renderContractBlock,
  renderContractForTask,
  type DelegateContract,
} from "./contract.js";
import { FUSION_WORKER_APPROVAL_MARKER } from "./worker-tool-policy.js";

/**
 * The single user message a fusion worker turn is started with.
 *
 * A worker is a fresh session: no transcript, no memory recall, no
 * operator. Everything it is allowed to assume has to be in this one
 * string, which is why `renderWorkerBrief` spells out the frame ("you
 * are a worker, you have no memory of the parent conversation") rather
 * than leaving the model to infer it from an instruction that reads
 * like the middle of a conversation.
 *
 * The three rules at the bottom exist because a worker's failure modes
 * are not a normal turn's. It cannot ask a question — nobody is
 * watching its session — so "never ask, act on the most reasonable
 * reading" replaces the usual clarification path. It cannot get an
 * approval, so the refusal marker gets an explicit handling rule that
 * turns a dead end into a hand-back. And its reply is not shown to a
 * person: it is pasted into the orchestrator's tool result, so it must
 * be a result, not a status report, and it must fit the budget the
 * orchestrator's own context can carry.
 */
export const WORKER_REPLY_CHAR_BUDGET = 4000;

/**
 * How much of the operator's original request a brief quotes.
 *
 * Why the request is quoted at all: a brief is the orchestrator's
 * summary, and summaries were thin (124–901 chars in one benchmark). A
 * worker told "write index.html and style.css, match all visual and
 * structural requirements" built a marketing landing page instead of the
 * game the operator asked for, and workers with thin briefs spent 30–40
 * steps reverse-engineering sibling modules off the disk. The request is
 * the one text every part of the job must agree with, so every worker
 * gets it — labelled as context, with its own task below.
 *
 * Bounded because every worker pays for it in its slot's context:
 * 16,000 chars is roughly 4K tokens, a real spec with room to spare,
 * and a request longer than that is clipped with a note saying so.
 */
export const ORIGINAL_REQUEST_CHAR_BUDGET = 16_000;

/**
 * A turn-starting message shorter than this is read as a follow-up
 * ("continue", "fix the failing test") rather than as the request
 * itself, so the brief quotes the message before it as well.
 */
export const FOLLOW_UP_MAX_CHARS = 280;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The request to quote in the briefs of a turn's fan-outs.
 *
 * `current` is the message that started the parent turn;
 * `earlierTurns` is the parent transcript as it stood before it. A
 * turn started without a message (a task runner resuming) falls back to
 * the last thing the operator said; a short follow-up is quoted together
 * with the message it follows up, because "continue" alone tells a
 * worker nothing about what is being continued.
 */
export function pickOriginalRequest(input: {
  current: string;
  earlierTurns: readonly ConversationTurn[];
}): string | undefined {
  const earlier = input.earlierTurns
    .flatMap((turn) => (turn.kind === "user" ? [turn.text.trim()] : []))
    .filter((text) => text.length > 0);
  const previous = earlier[earlier.length - 1];
  const current = input.current.trim();
  if (current.length === 0) return previous;
  if (current.length >= FOLLOW_UP_MAX_CHARS || previous === undefined) {
    return current;
  }
  return `${previous}\n\n${REQUEST_FOLLOW_UP_MARKER}\n${current}`;
}

function quoteOriginalRequest(request: string): string[] {
  const clipped =
    request.length > ORIGINAL_REQUEST_CHAR_BUDGET
      ? request.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET)
      : request;
  const lines = [
    `ORIGINAL REQUEST — context only; your task is below. This is the operator's whole job, which the orchestrator split across several workers. Use it for the names, formats, constraints and look your part must agree with, and do only your TASK.`,
    `----- BEGIN ORIGINAL REQUEST -----`,
    clipped,
    `----- END ORIGINAL REQUEST -----`,
  ];
  if (clipped.length < request.length) {
    lines.push(
      `(truncated: the original request is ${formatCount(request.length)} chars; only the first ${formatCount(ORIGINAL_REQUEST_CHAR_BUDGET)} are quoted above.)`,
    );
  }
  return lines;
}

/**
 * The contract, when the fan-out has one, sits between the request
 * (what the whole job is) and the task (what this worker does): the
 * shared block first, then the three lines that say what it means for
 * this task. Every worker of the fan-out reads the same shared block,
 * which is the point — the names they must agree on are written once,
 * not paraphrased eight times.
 */
function quoteContract(contract: DelegateContract, taskId: string): string[] {
  return [
    renderContractBlock(contract),
    `For TASK ${taskId}:`,
    renderContractForTask(contract, taskId),
  ];
}

export function renderWorkerBrief(
  task: DelegateTask,
  options: {
    workingDir: string;
    originalRequest?: string;
    contract?: DelegateContract;
  },
): string {
  const request = options.originalRequest?.trim() ?? "";
  const lines: string[] = [
    `You are a worker agent executing one delegated task inside ${options.workingDir}; you have no memory of the parent conversation.`,
    ``,
    ...(request.length > 0 ? [...quoteOriginalRequest(request), ``] : []),
    ...(options.contract ? [...quoteContract(options.contract, task.id), ``] : []),
    `TASK ${task.id}: ${task.title}`,
    ``,
    task.instructions,
  ];
  if (task.deliverable) {
    lines.push(``, `DELIVERABLE: ${task.deliverable}`);
  }
  if (task.files && task.files.length > 0) {
    lines.push(``, `FILES:`, ...task.files.map((f) => `- ${f}`));
  }
  lines.push(
    ``,
    `RULES:`,
    `- Work autonomously. Never ask a question and never wait for confirmation — there is no user on this session. If something is ambiguous, take the most reasonable reading and say what you assumed in your reply.`,
    `- \`os.fs.write\` creates any missing parent directories itself, so \`mkdir\` is never needed before a write.`,
    `- The operator authorised this fan-out to write files AND run commands in the directories the task names, so working there needs no permission: write the files, run the build, run the tests, read the output. Anything outside them is refused, not queued: a tool result carrying "${FUSION_WORKER_APPROVAL_MARKER}" means nobody can approve it here. Stop retrying it and say in your reply exactly what was blocked and where, so the orchestrator can re-send the task with that path named — it cannot run the action for you.`,
    `- Read files only inside ${options.workingDir} and the directories this task writes in; a read anywhere else is refused. Do not search other projects for context — ${request.length > 0 ? "your task, its FILES and the original request are" : "your task and its FILES are"} the context you have.`,
    `- Finish with \`reply\` carrying the concise result of this task (about ${WORKER_REPLY_CHAR_BUDGET} characters at most). That reply is the ONLY thing the orchestrator receives — findings, file paths, decisions and anything it needs to merge your part must be inside it.`,
    ...(options.contract
      ? [
          `- End the reply with a \`PROVIDED:\` list of what you produced, one line per item, using the CONTRACT's exact names (kind, name, path). Name anything you provide differently from the contract, or could not provide, on its own line.`,
        ]
      : []),
  );
  return lines.join("\n");
}
