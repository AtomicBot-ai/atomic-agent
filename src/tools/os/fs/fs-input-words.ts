/**
 * The word rules of the input guard (`fs-input-guard.ts`): when a text
 * names a file, and when a replace verb in it reaches that name. Shared
 * by the request rules and the answer-to-a-question rules
 * (`fs-input-consent.ts`).
 */

export const REPLACE_VERBS = [
  "rewrite",
  "replace",
  "regenerate",
  "overwrite",
  "recreate",
  "reset",
] as const;

/**
 * The same verbs in Russian, as stems: "перезаписать" / "перезапиши",
 * "заменить" / "замени", "переписать" / "перепиши", "пересоздать".
 */
const REPLACE_STEMS_RU = ["перезапис", "замен", "перепис", "перепиш", "пересозд"] as const;

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
  "не",
  "без",
  "вместо",
  "нельзя",
]);
const NEGATION_WINDOW_WORDS = 3;

/** A character that continues a file name: `old-sales.csv` does not name `sales.csv`. */
const NAME_CHAR = /[A-Za-z0-9_.-]/;
/** A token ending like this closes the sentence the verb window runs over. */
export const SENTENCE_END = /[.!?;:]$/;

/** A word lowered and stripped of the punctuation around it, any script. */
export function bareToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+/u, "")
    .replace(/[^\p{L}\p{N}']+$/u, "");
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
  return replaceVerbReaches(request, (word) => requestNamesFile(word, name));
}

/**
 * Is there an un-negated replace verb with a word `matches` accepts
 * within `REPLACE_VERB_WINDOW_WORDS` words after it, in the same
 * sentence?
 */
export function replaceVerbReaches(
  text: string,
  matches: (word: string, next: string | undefined) => boolean,
): boolean {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    if (!isReplaceVerb(words[i]!) || isNegated(words, i)) continue;
    const window = words.slice(i + 1, i + 1 + REPLACE_VERB_WINDOW_WORDS);
    for (let j = 0; j < window.length; j += 1) {
      const word = window[j]!;
      if (matches(word, window[j + 1])) return true;
      if (SENTENCE_END.test(word)) break;
    }
  }
  return false;
}

/**
 * Any inflection: the stem without its final `e` covers "rewriting",
 * "replaced", "resets"; the Russian stems cover their own endings.
 */
function isReplaceVerb(word: string): boolean {
  const bare = bareToken(word);
  return (
    REPLACE_VERBS.some((verb) => bare.startsWith(verb.replace(/e$/, ""))) ||
    REPLACE_STEMS_RU.some((stem) => bare.startsWith(stem))
  );
}

function isNegated(words: readonly string[], verbAt: number): boolean {
  const from = Math.max(0, verbAt - NEGATION_WINDOW_WORDS);
  for (let i = from; i < verbAt; i += 1) {
    if (NEGATIONS.has(bareToken(words[i]!))) return true;
  }
  return false;
}
