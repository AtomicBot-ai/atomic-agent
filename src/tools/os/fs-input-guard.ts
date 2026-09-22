import { basename } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import { quotedRequestText } from "../../prompt/request-section.js";
import {
  countLines,
  formatBytes,
  formatLines,
  formatNumber,
  type PriorFile,
} from "./fs-replace-guard.js";
import type { FileRestoreStore } from "./fs-restore-store.js";

/**
 * The one refusal in front of `os.fs.write` (F51): a file the request
 * names as an input is not replaced without `overwrite: true`.
 *
 * F36 made a replacement announced and reversible. Live, five first
 * attempts across two local models still failed the same way: the model
 * rewrote `projects.json` or `sales.csv` — the file the request named as
 * ITS INPUT — from memory, read the warning, and went on. A warning is
 * advice; the write had landed. So before `os.fs.write` replaces a file
 * that existed before the turn and was not created by this session (the
 * restore store's created set), and whose basename appears in the
 * turn's pinned request (`pickOriginalRequest`; for a worker, the
 * ORIGINAL REQUEST block of its brief — `quotedRequestText`), the call
 * is refused with the counts and the way onward: edit it in place
 * (`os.fs.edit` / `os.fs.patch`, never refused by this rule), or pass
 * `overwrite: true` when replacing it is what the user asked for.
 *
 * The request's own words lift the rule: a basename within
 * `REPLACE_VERB_WINDOW_WORDS` words after "rewrite", "replace",
 * "regenerate", "overwrite", "recreate" or "reset" (any inflection,
 * case-insensitive, up to the end of that sentence) is a file the user
 * asked to have replaced — unless the verb is negated ("do not overwrite
 * sales.csv"). Every other pre-existing file keeps F36's warn-and-save
 * path. Decided before the approval prompt, so the operator is never
 * asked to approve a write that will not run.
 */

export const REPLACE_VERBS = [
  "rewrite",
  "replace",
  "regenerate",
  "overwrite",
  "recreate",
  "reset",
] as const;

/** How far after a replace verb the basename may sit to count as asked for. */
export const REPLACE_VERB_WINDOW_WORDS = 6;

/** "do not overwrite", "rather than replacing", "instead of rewriting". */
const NEGATIONS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "don't",
  "dont",
  "no",
  "nor",
  "without",
  "than",
  "instead",
]);
const NEGATION_WINDOW_WORDS = 3;

/** A character that continues a file name: `old-sales.csv` does not name `sales.csv`. */
const NAME_CHAR = /[A-Za-z0-9_.-]/;
/** A token ending like this closes the sentence the verb window runs over. */
const SENTENCE_END = /[.!?;:]$/;

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
   * Absolute paths the fan-out's contract declared as inputs for this
   * session (`fs-declared-inputs.ts`, workers only). Refused whatever
   * `overwrite` says: the orchestrator declared them, and it can
   * redeclare.
   */
  declaredInputs?: readonly string[];
  overwrite: boolean;
}

export interface InputRefusal {
  /** The file is named by the request, or declared by the fan-out's contract. */
  reason: "request" | "contract";
  text: string;
  details: Record<string, unknown>;
}

/**
 * Does `request` name `name` as a whole file name? Case-insensitive; a
 * path prefix (`data/sales.csv`) counts, a longer name (`old-sales.csv`,
 * `sales.csv.bak`) does not, a sentence's full stop after it is fine.
 */
export function requestNamesFile(request: string, name: string): boolean {
  const haystack = request.toLowerCase();
  const needle = name.toLowerCase();
  if (needle.length === 0) return false;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (isWholeName(haystack, at, at + needle.length)) return true;
  }
  return false;
}

function isWholeName(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  if (before !== undefined && NAME_CHAR.test(before)) return false;
  const after = text[end];
  if (after === undefined) return true;
  if (after === ".") {
    const next = text[end + 1];
    return next === undefined || !NAME_CHAR.test(next);
  }
  return !NAME_CHAR.test(after);
}

/**
 * Does the request ask for `name` to be replaced — the basename within
 * `REPLACE_VERB_WINDOW_WORDS` words after a replace verb, in the same
 * sentence, the verb not negated?
 */
export function requestAsksToReplace(request: string, name: string): boolean {
  const words = request.split(/\s+/).filter((word) => word.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    if (!isReplaceVerb(words[i]!) || isNegated(words, i)) continue;
    const window = words.slice(i + 1, i + 1 + REPLACE_VERB_WINDOW_WORDS);
    for (const word of window) {
      if (requestNamesFile(word, name)) return true;
      if (SENTENCE_END.test(word)) break;
    }
  }
  return false;
}

function bareWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z']+/, "");
}

/** Any inflection: the stem without its final `e` covers "rewriting", "replaced", "resets". */
function isReplaceVerb(word: string): boolean {
  const bare = bareWord(word);
  return REPLACE_VERBS.some((verb) => bare.startsWith(verb.replace(/e$/, "")));
}

function isNegated(words: readonly string[], verbAt: number): boolean {
  const from = Math.max(0, verbAt - NEGATION_WINDOW_WORDS);
  for (let i = from; i < verbAt; i += 1) {
    if (NEGATIONS.has(bareWord(words[i]!).replace(/[^a-z']+$/, ""))) {
      return true;
    }
  }
  return false;
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
  if (input.overwrite) return null;
  const request = input.request?.trim() ?? "";
  if (
    request.length === 0 ||
    input.store === undefined ||
    input.prior.bytes === 0
  ) {
    return null;
  }
  const name = basename(input.absolute);
  const words = quotedRequestText(request);
  if (!requestNamesFile(words, name) || requestAsksToReplace(words, name)) {
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
 * onward does — a worker told to pass `overwrite: true` for a declared
 * input would loop on a key that is ignored for it.
 */
function refusal(
  reason: InputRefusal["reason"],
  input: InputGuardInput,
): InputRefusal {
  const linesAfter = countLines(input.after);
  const counts = formatReplacementCounts(input.prior, linesAfter);
  const text =
    reason === "request"
      ? `refused: ${input.display} is an input the request names (${counts}); edit it in place (os.fs.edit / os.fs.patch), or pass overwrite: true if replacing it is really what the user asked for`
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
 * not enough for a message whose point is the way onward: the longer of
 * the two texts above is 224 characters of fixed wording before
 * `display` and `counts` are interpolated, so a 186-character absolute
 * path — an ordinary one under a session workspace — already makes it
 * 431, and the head slice at 385 eats exactly the end: the
 * `os.fs.edit` / `os.fs.patch` instruction and the "say so in your
 * reply so the orchestrator can redeclare it" escape hatch. The model
 * would be told it was refused and never told what to do instead.
 *
 * The message is one line, so the tail slice never fires and only the
 * length matters, and its one unbounded part is the path, which the
 * filesystem bounds at PATH_MAX. 224 + 40 for the widest counts
 * (`12345.6 MB → 1,234,567,890 lines`) + 1024 = 1288, so this keeps
 * whole every refusal this guard can build.
 */
export const INPUT_REFUSAL_SUMMARY_CHARS = 1300;

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
