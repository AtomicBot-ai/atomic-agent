/* ---------------- new task in plain words (ATO-519) ----------------
   Loaded before renderer.js; declares only.

   A new task starts with one sentence to the agent ("every weekday at 9,
   send me a summary") instead of a cron field. The sentence goes to the
   agent in a new chat, and the agent schedules it with its own tools
   (tasks.cron for a repeating schedule, tasks.schedule for a single run):
   the same path a person typing the request in chat takes, with no new
   backend. The cron / interval / at form stays one click away as
   "Set up manually".

   These are the words and the message; renderer.js owns the form
   (tkFormHTML) and the send (tkAsk). */

/** Examples under the field. A click puts one in the field; it is not sent. */
const TASK_ASK_EXAMPLES = [
  'every weekday at 9, send me a summary of the news about local AI',
  'every Monday at 10, list what changed in this folder last week',
  'tomorrow at 8, remind me to call the dentist',
];

const TASK_ASK_PLACEHOLDER = 'every weekday at 9, send me a summary';

/** The manual form's preview card before a schedule has been typed (U-86). */
const TASK_PREVIEW_EMPTY = 'Next runs appear here once you enter a schedule.';

/** The empty task list's hint (U-85). */
const TASK_EMPTY_HINT = 'Press New task and write what to do and when, for example: every weekday at 9, send me a summary.';

/**
 * The chat message for a sentence typed in the field, or '' for nothing
 * typed. The request names the agent's task tools so a small local model
 * schedules the work instead of doing it once right now.
 */
function taskAskMessage(phrase) {
  const text = String(phrase == null ? '' : phrase).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return 'Set up a scheduled task: ' + text + '\n\n'
    + 'Use your task tools to schedule it (tasks.cron for a repeating schedule, tasks.schedule for a single run). '
    + 'Then tell me the schedule you set and when it runs next.';
}

if (typeof module !== 'undefined') {
  module.exports = {TASK_ASK_EXAMPLES, TASK_ASK_PLACEHOLDER, TASK_PREVIEW_EMPTY, TASK_EMPTY_HINT, taskAskMessage};
}
