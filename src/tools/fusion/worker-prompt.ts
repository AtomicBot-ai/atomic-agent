import type { DelegateTask } from "./delegate-args.js";
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

export function renderWorkerBrief(
  task: DelegateTask,
  options: { workingDir: string },
): string {
  const lines: string[] = [
    `You are a worker agent executing one delegated task inside ${options.workingDir}; you have no memory of the parent conversation.`,
    ``,
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
    `- \`os.fs.write\` creates any missing parent directories itself. Do not run \`mkdir\` first: a shell command needs an approval you cannot get, so it costs you a step and returns nothing.`,
    `- The operator authorised this fan-out to write in the directories the task names, so writing there just works. Anything outside them is refused, not queued: a tool result carrying "${FUSION_WORKER_APPROVAL_MARKER}" means nobody can approve it here. Stop retrying it and say in your reply exactly what was blocked and where, so the orchestrator can re-send the task with that path named — it cannot run the action for you.`,
    `- Finish with \`reply\` carrying the concise result of this task (about ${WORKER_REPLY_CHAR_BUDGET} characters at most). That reply is the ONLY thing the orchestrator receives — findings, file paths, decisions and anything it needs to merge your part must be inside it.`,
  );
  return lines.join("\n");
}
