import { basename } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { requestWords } from "../../../prompt/request-section.js";
import { answersReplaceQuestion } from "./fs-input-consent.js";
import { requestAsksToReplace, requestNamesFile } from "./fs-input-words.js";
import {
  countLines,
  formatBytes,
  formatLines,
  formatNumber,
  type PriorFile,
} from "./fs-replace-guard.js";
import type { FileRestoreStore } from "./fs-restore-store.js";

export {
  REPLACE_VERBS,
  REPLACE_VERB_WINDOW_WORDS,
  requestAsksToReplace,
  requestNamesFile,
} from "./fs-input-words.js";
export {
  answersReplaceQuestion,
  followUpAsksToReplace,
  replyAsksToReplace,
} from "./fs-input-consent.js";

/**
 * The one refusal in front of `os.fs.write` (F51): a file the request
 * names as an input is not replaced by a write. The call's `overwrite`
 * flag does not lift it (ATO-851).
 *
 * F36 made a replacement announced and reversible. Live, five first
 * attempts across two local models still failed the same way: the model
 * rewrote `projects.json` or `sales.csv` — the file the request named as
 * ITS INPUT — from memory, read the warning, and went on. A warning is
 * advice; the write had landed. So before `os.fs.write` replaces a file
 * that existed before the turn and was not created by this session (the
 * restore store's created set), and whose basename appears in the
 * turn's pinned request (`pickOriginalRequest`; for a worker, the
 * ORIGINAL REQUEST block of its brief — `requestWords`), the call
 * is refused with the counts and the way onward: write the result to a
 * new file, edit it in place (`os.fs.edit` / `os.fs.patch`, never
 * refused by this rule), or ask the user. The refusal never names
 * `overwrite: true`: live (ATO-849), small models read that hint as the
 * next step and replaced the user's input on the very next call, so the
 * refusal itself was the bypass.
 *
 * Nor does `overwrite: true` (ATO-851). After #712 the persona line and
 * the write descriptor still taught the flag, and at approval levels
 * 2-5 a workspace write approves itself, so the bypass was still one
 * model step. Input files are now treated the way a fan-out's declared
 * inputs always were: the flag is not read. Only the user's words lift
 * the rule.
 *
 * The request's own words lift it: a basename within
 * `REPLACE_VERB_WINDOW_WORDS` words after "rewrite", "replace",
 * "regenerate", "overwrite", "recreate" or "reset" (any inflection,
 * case-insensitive, up to the end of that sentence) is a file the user
 * asked to have replaced — unless the verb is negated ("do not overwrite
 * sales.csv"). So does the user's next message when it is a short
 * follow-up (`pickOriginalRequest` appends it after
 * `REQUEST_FOLLOW_UP_MARKER`) that names the file: "replace
 * numbers.txt". A longer next message is the whole request on its own
 * and is read the same way.
 *
 * And so does an answer to the agent's own question (ATO-860). When the
 * agent's previous reply asked, in a question sentence, to replace a
 * file ("Replace sales.csv?", the question the refusal tells it to
 * ask), a plain yes ("yes", "ok", "да") or a pointer ("yes, replace
 * it") lifts the rule for the files that question named, and for no
 * other. A pointer with no such question lifts nothing: "replace that
 * line" is about a line. A worker reads its parent's previous reply,
 * and a worker brief with no ORIGINAL REQUEST block has no operator
 * words to agree with (`requestWords`). Every other pre-existing file
 * keeps F36's warn-and-save path. Decided before the approval prompt,
 * so the operator is never asked to approve a write that will not run.
 */

export interface InputGuardInput {
  store: FileRestoreStore | undefined;
  sessionId: string;
  absolute: string;
  /** The path as the call spelled it — what the refusal names. */
  display: string;
  prior: PriorFile;
  after: string;
  /** The turn's pinned request, when the runtime recorded one. */
  request: string | undefined;
  /**
   * The agent's reply just before the user's message that started the
   * turn (`previousReplyText`; a worker's is its parent's). Its question
   * names the files a plain yes agrees to replace (ATO-860).
   */
  previousReply?: string | undefined;
  /**
   * Absolute paths the fan-out's contract declared as inputs for this
   * session (`fs-declared-inputs.ts`, workers only). Refused whatever
   * the request says: the orchestrator declared them, and it can
   * redeclare.
   */
  declaredInputs?: readonly string[];
  /**
   * The call's flag. Never lifts the refusal (ATO-851); carried only
   * so the refusal's details record that it was passed.
   */
  overwrite: boolean;
}

export interface InputRefusal {
  /** The file is named by the request, or declared by the fan-out's contract. */
  reason: "request" | "contract";
  text: string;
  details: Record<string, unknown>;
}

/**
 * The refusal for this write, or `null` when it may go on to the
 * approval prompt and the F36 guard. A declared input is refused first
 * and unconditionally. By name, nothing is claimed without a store
 * (nothing could tell the agent's files from the user's), for an empty
 * file (nothing to lose), or without a pinned request (nothing named).
 */
export async function checkInputReplacement(
  input: InputGuardInput,
): Promise<InputRefusal | null> {
  if (input.declaredInputs?.includes(input.absolute)) {
    return refusal("contract", input);
  }
  // `input.overwrite` is deliberately not read (ATO-851): only the
  // user's words below lift the refusal.
  const request = input.request?.trim() ?? "";
  if (
    request.length === 0 ||
    input.store === undefined ||
    input.prior.bytes === 0
  ) {
    return null;
  }
  const name = basename(input.absolute);
  const { names, consent } = requestWords(request);
  if (
    !requestNamesFile(names, name) ||
    requestAsksToReplace(consent, name) ||
    answersReplaceQuestion(consent, input.previousReply, name)
  ) {
    return null;
  }
  if (await input.store.wasCreated(input.sessionId, input.absolute)) {
    return null;
  }
  return refusal("request", input);
}

/** `2,401 lines → 10`, or `12.3 MB → 10 lines` for a file never read — the write tool's own wording. */
export function formatReplacementCounts(
  prior: PriorFile,
  linesAfter: number,
): string {
  return prior.lines === null
    ? `${formatBytes(prior.bytes)} → ${formatLines(linesAfter)}`
    : `${formatLines(prior.lines)} → ${formatNumber(linesAfter)}`;
}

/**
 * The same head for both reasons; the tail differs because the way
 * onward does: a worker cannot reach the user, so it hands the question
 * to the orchestrator. Neither tail suggests `overwrite: true` (see the
 * top of this file). The request tail spells out the one question to
 * ask, in the words `replyAsksToReplace` reads, and says a write before
 * the answer is refused again: told only to "ask them first", small
 * models kept retrying the write instead (ATO-860).
 */
function refusal(
  reason: InputRefusal["reason"],
  input: InputGuardInput,
): InputRefusal {
  const linesAfter = countLines(input.after);
  const counts = formatReplacementCounts(input.prior, linesAfter);
  const text =
    reason === "request"
      ? `refused: ${input.display} is an input the request names (${counts}); write the result to a new file, or edit it in place (os.fs.edit / os.fs.patch). To replace the file itself, stop and reply with one yes/no question: "Replace ${basename(input.absolute)}?" A write before the user answers yes is refused again`
      : `refused: ${input.display} is an input this fan-out declared (${counts}); edit it in place (os.fs.edit / os.fs.patch) — a worker cannot replace a declared input; if the task needs it replaced, say so in your reply so the orchestrator can redeclare it`;
  return {
    reason,
    text,
    details: {
      refused: "input",
      input: reason,
      path: input.absolute,
      display: input.display,
      bytesBefore: input.prior.bytes,
      linesBefore: input.prior.lines,
      linesAfter,
      overwrite: input.overwrite,
    },
  };
}

/**
 * What the refusal is compressed with. The compressor's default 400 is
 * not enough for a message whose point is the way onward: the
 * declared-input text above is 224 characters of fixed wording before
 * `display` and `counts` are interpolated, so a 186-character absolute
 * path — an ordinary one under a session workspace — already makes it
 * 431, and the head slice at 385 eats exactly the end: the
 * `os.fs.edit` / `os.fs.patch` instruction and the "say so in your
 * reply so the orchestrator can redeclare it" escape hatch. The model
 * would be told it was refused and never told what to do instead.
 *
 * The message is one line, so the tail slice never fires and only the
 * length matters. Its unbounded parts are the path, which the
 * filesystem bounds at PATH_MAX, and, in the request text, the file's
 * basename in the question to ask (ATO-860), bounded at NAME_MAX. That
 * text is the longer one now: 257 characters of fixed wording + 40 for
 * the widest counts (`12345.6 MB → 1,234,567,890 lines`) + 1024 + 255 =
 * 1576, so this keeps whole every refusal this guard can build.
 */
export const INPUT_REFUSAL_SUMMARY_CHARS = 1600;

/** The tool result a refused write returns instead of running. */
export function refuseInputReplacement(
  tool: string,
  refused: InputRefusal,
): CompressedToolResult {
  return compressToolResult(
    {
      tool,
      status: "error",
      output: refused.text,
      details: refused.details,
    },
    { maxSummaryLength: INPUT_REFUSAL_SUMMARY_CHARS },
  );
}
