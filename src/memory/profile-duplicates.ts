/**
 * Duplicate detection for profile writes (ATO-188).
 *
 * The agent's `memory.profile.set` and the background reflection write
 * independently, so the same fact landed twice: `name = Надя` as two
 * versions of one key, and `prefers_short_answers = yes` beside
 * `response_length_preference = short`. Every write is a new row
 * (bi-temporal store), so a repeat is not free — it grows the history
 * chain and, under a second key, the prompt.
 *
 * Two checks, both deliberately narrow:
 *  - `same`: the key already holds this value (case, spacing and
 *    trailing punctuation aside). Both writers skip it.
 *  - `near`: another key already says the same thing — another name key
 *    with the same name, or a key + value with exactly the same content
 *    words once synonyms are folded and filler dropped ("prefers short
 *    answers = yes" and "response length preference = short" are both
 *    {short, reply}). Equal, not merely overlapping: "language_learning
 *    = ru" adds to "language = ru", it does not repeat it. Only
 *    reflection skips these; the agent's own explicit write under a new
 *    key is left alone. A negation on one side only ("no" vs "yes") is
 *    never a duplicate.
 */

import { isNameProfileKey } from "./profile-name-keys.js";
import type { ProfileFact } from "./profile-store.js";

export interface DuplicateFact {
  /** The stored fact the write would repeat. */
  fact: ProfileFact;
  kind: "same" | "near";
}

/** Value as compared: case, inner spacing, trailing punctuation aside. */
export function normaliseProfileValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?;,]+$/u, "");
}

/** Words that carry no content of their own in a key or a value. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "user",
  "users",
  "my",
  "the",
  "a",
  "an",
  "of",
  "to",
  "for",
  "in",
  "on",
  "is",
  "are",
  "be",
  "yes",
  "true",
  "prefers",
  "prefer",
  "preferred",
  "preference",
  "preferences",
  "pref",
  "likes",
  "like",
  "wants",
  "want",
  "style",
  "setting",
  "settings",
  "value",
  // Dimension words: "response length = short" says no more than "short
  // responses".
  "length",
  "level",
  "size",
  "amount",
  "type",
  "kind",
  "пользователь",
  "предпочитает",
  "предпочтение",
  "да",
]);

const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "false",
  "never",
  "none",
  "off",
  "нет",
  "не",
  "никогда",
]);

/** Words that name the same concept. */
const SYNONYMS: Readonly<Record<string, string>> = {
  answer: "reply",
  answers: "reply",
  response: "reply",
  responses: "reply",
  reply: "reply",
  replies: "reply",
  ответ: "reply",
  ответы: "reply",
  ответов: "reply",
  short: "short",
  shorter: "short",
  brief: "short",
  concise: "short",
  terse: "short",
  краткие: "short",
  короткие: "short",
  кратко: "short",
  коротко: "short",
  long: "long",
  longer: "long",
  detailed: "long",
  verbose: "long",
  подробные: "long",
  подробно: "long",
  lang: "language",
  language: "language",
  язык: "language",
  tz: "timezone",
  timezone: "timezone",
};

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Content words of a key + value, synonyms folded, crudely stemmed. */
function concepts(key: string, value: string): Set<string> {
  const out = new Set<string>();
  for (const word of [...words(key.replace(/[_.-]+/g, " ")), ...words(value)]) {
    if (FILLER_WORDS.has(word) || NEGATION_WORDS.has(word)) continue;
    const synonym = SYNONYMS[word];
    if (synonym !== undefined) out.add(synonym);
    else if (word.length >= 2) out.add(word.length > 5 ? word.slice(0, 5) : word);
  }
  return out;
}

function negated(key: string, value: string): boolean {
  return [...words(key.replace(/[_.-]+/g, " ")), ...words(value)].some((w) =>
    NEGATION_WORDS.has(w),
  );
}

/**
 * The stored fact a write of `key = value` would repeat, or `null`.
 * `existing` is the active profile (`ProfileStore.list()`).
 */
export function findDuplicateFact(
  existing: readonly ProfileFact[],
  key: string,
  value: string,
): DuplicateFact | null {
  const wanted = normaliseProfileValue(value);
  for (const fact of existing) {
    if (fact.key === key && normaliseProfileValue(fact.value) === wanted) {
      return { fact, kind: "same" };
    }
  }
  const nameKey = isNameProfileKey(key);
  const mine = concepts(key, value);
  const mineNegated = negated(key, value);
  for (const fact of existing) {
    if (fact.key === key) continue;
    if (nameKey) {
      if (isNameProfileKey(fact.key) && normaliseProfileValue(fact.value) === wanted) {
        return { fact, kind: "near" };
      }
      continue;
    }
    if (isNameProfileKey(fact.key)) continue;
    if (negated(fact.key, fact.value) !== mineNegated) continue;
    const theirs = concepts(fact.key, fact.value);
    if (mine.size < 2 || mine.size !== theirs.size) continue;
    if ([...mine].every((c) => theirs.has(c))) return { fact, kind: "near" };
  }
  return null;
}
