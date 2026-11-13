/**
 * A worker's question to the orchestrator (ATO-945).
 *
 * A worker cannot ask anyone mid-task: its session has no user, and the
 * orchestrator's turn is blocked inside the `fusion.delegate` call that
 * started it. So a question is not a blocking call. A worker that cannot
 * do its task right without an answer only the orchestrator has (a name,
 * a format, a choice between readings that changes the result) stops and
 * ends its reply with one `NEEDS_INPUT: <question>` line. The task comes
 * back `needs_input` with the question on the row; the orchestrator
 * answers it from its own context and sends the task out again with the
 * answer in the instructions.
 *
 * Only a worker that ended its turn on its own (`ok`) is read for one: a
 * reply written on a forced final step, or by a worker that failed, says
 * something else first. A question is not a failure, so the breaker's
 * streak treats it like a finished task.
 */

/** The line a worker's reply ends with to ask the orchestrator. */
export const NEEDS_INPUT_MARKER = "NEEDS_INPUT:";

/** How long a question may be. It lands on the status table row. */
export const MAX_WORKER_QUESTION_CHARS = 300;

/** The row's note: what the orchestrator does with a question. */
export const WORKER_NEEDS_INPUT_NOTE =
  "the worker stopped to ask a question: answer it from what you know and send this task out again with the answer in its instructions; ask the user only if nobody else can answer";

const HEADER = /^\s*[*_`]*NEEDS_INPUT[*_`]*\s*:[*_`]*/i;

/**
 * The question in a reply: the text after the last `NEEDS_INPUT:` line
 * start, with the lines that follow it up to a blank line, flattened and
 * cut to `MAX_WORKER_QUESTION_CHARS`. `undefined` when there is none or
 * it is empty. The marker must start a line, so a reply that merely
 * quotes the rule ("I could have used NEEDS_INPUT: …") is not a question.
 */
export function readWorkerQuestion(reply: string): string | undefined {
  const lines = reply.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADER.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const parts = [lines[start]!.replace(HEADER, "")];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) break;
    parts.push(line);
  }
  const flat = parts.join(" ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length > MAX_WORKER_QUESTION_CHARS
    ? `${flat.slice(0, MAX_WORKER_QUESTION_CHARS - 1)}…`
    : flat;
}

/** The brief's rule: when and how a worker asks. */
export const WORKER_QUESTION_RULE = `- Only if the task cannot be done right without an answer only the orchestrator has (a name, a format, a choice between readings that changes the result), stop and end your reply with one line \`${NEEDS_INPUT_MARKER} <one short question>\`, naming the file or symbol it is about and what you tried. The orchestrator answers it and sends the task again; anything you can reasonably decide yourself, decide.`;
