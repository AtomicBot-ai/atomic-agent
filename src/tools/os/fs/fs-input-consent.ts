import { REQUEST_FOLLOW_UP_MARKER } from "../../../prompt/request-section.js";
import {
  bareToken,
  replaceVerbReaches,
  requestNamesFile,
  SENTENCE_END,
} from "./fs-input-words.js";

/**
 * The words of an answer to the agent's own question (ATO-860): the
 * pieces `fs-input-guard.ts` puts together to let a plain "yes" to
 * "Replace sales.csv?" replace `sales.csv`, and nothing else.
 *
 * Before, the guard read the user's words alone. A plain "yes" named no
 * file and no verb, so it never counted, and the model asked again until
 * the user typed "yes, replace it"; while any short "replace it" counted
 * for every input the request named, whatever the user had pointed at.
 * Small models looped on the refusal instead of asking at all. Now the
 * agent's previous reply is read too: a question sentence in it that
 * asks to replace a file names what a yes agrees to.
 */

/** A word that says yes on its own. */
const AFFIRMATIVE_WORDS: ReadonlySet<string> = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "k",
  "sure",
  "fine",
  "alright",
  "ahead",
  "proceed",
  "confirm",
  "confirmed",
  "approved",
  "да",
  "ага",
  "угу",
  "ок",
  "окей",
  "давай",
  "конечно",
  "можно",
  "валяй",
  "го",
  "подтверждаю",
]);

/** What a yes may carry around it: "yes please", "ok go ahead and do it". */
const AFFIRMATIVE_FILLER: ReadonlySet<string> = new Set([
  "please",
  "pls",
  "go",
  "do",
  "it",
  "that",
  "just",
  "and",
  "thanks",
  "thank",
  "you",
  "of",
  "course",
  "sounds",
  "good",
  "absolutely",
  "пожалуйста",
  "делай",
  "сделай",
  "так",
  "спасибо",
  "разумеется",
]);

/** Longer than this, a reply says more than yes and is read by the verb rules. */
const PLAIN_YES_MAX_WORDS = 8;

/**
 * Is `reply` a plain yes: every word a yes or the filler around one, at
 * least one a yes? "yes", "ok, go ahead", "да, давай". A "no" or "not"
 * is neither, so "yes, but not now" is not one.
 */
export function isPlainYes(reply: string): boolean {
  const words = reply
    .split(/\s+/)
    .map(bareToken)
    .filter((word) => word.length > 0);
  if (words.length === 0 || words.length > PLAIN_YES_MAX_WORDS) return false;
  let yes = false;
  for (const word of words) {
    if (AFFIRMATIVE_WORDS.has(word)) yes = true;
    else if (!AFFIRMATIVE_FILLER.has(word)) return false;
  }
  return yes;
}

/**
 * The user's message that started this turn, out of the operator's
 * words of a pinned request: the text after `REQUEST_FOLLOW_UP_MARKER`
 * when the record merged a short follow-up, else the whole text.
 */
export function latestUserMessage(consent: string): string {
  const at = consent.lastIndexOf(REQUEST_FOLLOW_UP_MARKER);
  return at === -1
    ? consent
    : consent.slice(at + REQUEST_FOLLOW_UP_MARKER.length);
}

/** Closing marks a question may sit inside: `**Replace sales.csv?**`. */
const TRAILING_WRAP = /["'`*_)\]»”]+$/u;

/**
 * The question sentences of the agent's reply, each as its words: a run
 * of words up to one that ends with "?" (closing quotes or markdown
 * after it are fine). Split on words, not on full stops, because
 * `sales.csv` has one.
 */
export function questionSentences(reply: string): string[][] {
  const questions: string[][] = [];
  let sentence: string[] = [];
  for (const word of reply.split(/\s+/)) {
    if (word.length === 0) continue;
    sentence.push(word);
    const end = word.replace(TRAILING_WRAP, "");
    if (!SENTENCE_END.test(end)) continue;
    if (end.endsWith("?")) questions.push(sentence);
    sentence = [];
  }
  return questions;
}

/** "replace it", "overwrite the file": what a reply to the model's question points with. */
const FOLLOW_UP_POINTERS: ReadonlySet<string> = new Set([
  "it",
  "them",
  "file",
  "files",
  "его",
  "её",
  "ее",
  "их",
  "файл",
  "файлы",
]);

/**
 * "replace that", "overwrite this file": a pointer only when nothing but
 * a file follows it. "replace that line" points at a line.
 */
const FOLLOW_UP_DEMONSTRATIVES: ReadonlySet<string> = new Set([
  "that",
  "this",
  "these",
  "those",
  "этот",
  "это",
  "эти",
]);
const DEMONSTRATIVE_NOUNS: ReadonlySet<string> = new Set([
  "file",
  "files",
  "one",
  "ones",
  "файл",
  "файлы",
]);

function isPointer(word: string, next: string | undefined): boolean {
  const bare = bareToken(word);
  if (FOLLOW_UP_POINTERS.has(bare)) return true;
  if (!FOLLOW_UP_DEMONSTRATIVES.has(bare)) return false;
  return (
    next === undefined ||
    SENTENCE_END.test(word) ||
    DEMONSTRATIVE_NOUNS.has(bareToken(next))
  );
}

/**
 * Does the user's short follow-up (the text after
 * `REQUEST_FOLLOW_UP_MARKER`) agree to a replacement by pointing at it:
 * "yes, replace it", "go ahead and overwrite the file"? Same verb,
 * window, sentence and negation rules as `requestAsksToReplace`; a
 * follow-up that names the file is already caught there. False when the
 * request has no follow-up: a pronoun in the request itself points at
 * nothing the model asked about. On its own this lifts nothing: what the
 * pointer points at is the file the agent's question named
 * (`answersReplaceQuestion`).
 */
export function followUpAsksToReplace(request: string): boolean {
  const at = request.lastIndexOf(REQUEST_FOLLOW_UP_MARKER);
  if (at === -1) return false;
  const latest = request.slice(at + REQUEST_FOLLOW_UP_MARKER.length);
  return replaceVerbReaches(latest, isPointer);
}

/**
 * Does the agent's reply ask, in a question sentence, to replace
 * `name`: "Replace sales.csv?", "Should I overwrite data/sales.csv with
 * the cleaned rows?", "Перезаписать sales.csv?" A statement ("I will
 * overwrite sales.csv.") or a negated verb is not a question about it.
 */
export function replyAsksToReplace(reply: string, name: string): boolean {
  return questionSentences(reply).some((words) =>
    replaceVerbReaches(words.join(" "), (word) => requestNamesFile(word, name)),
  );
}

/**
 * Is the user's latest message an answer that agrees to the agent's
 * question about replacing `name`: the question named it, and the
 * answer is a plain yes or points at the replacement ("yes, replace
 * it")? Only the files that question named are agreed to.
 */
export function answersReplaceQuestion(
  consent: string,
  previousReply: string | undefined,
  name: string,
): boolean {
  if (previousReply === undefined || consent.trim().length === 0) return false;
  if (!replyAsksToReplace(previousReply, name)) return false;
  return isPlainYes(latestUserMessage(consent)) || followUpAsksToReplace(consent);
}
