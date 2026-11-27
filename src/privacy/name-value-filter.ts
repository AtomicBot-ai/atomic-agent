/**
 * What the local name pass found, made safe to mask everywhere
 * (ATO-2527). Runs between the detector and `PrivacyVault.learn`.
 *
 * Two jobs:
 *
 *  - Keep ordinary words readable. A small model sometimes calls a plain
 *    word an organisation ("support", "the team", "Банк"). Masked as a
 *    whole word in every later message, that would shred the chat. So a
 *    value on the keep list is dropped, and an `ORG` with no capital
 *    letter and no digit is dropped too (a real organisation is written
 *    with a capital or a number: "Acme", "ООО Ромашка", "School 57").
 *    The same idea as the `allow_list` of Microsoft Presidio.
 *  - Cover a name wherever its parts go. "Иван Петров" is also learned as
 *    "Иван" and "Петров", so a name written in two message parts
 *    (`"Call Иван"` + `" Петров"`), or later by its first name alone,
 *    is still masked. The full name stays first and gets the first
 *    placeholder; the vault masks longest first.
 *
 * Only drops or adds whole values; never edits one.
 */

import type { ModelFoundValue } from "./detect-private-data.js";

/**
 * Words a model may report that are not private on their own: titles,
 * generic organisation words, chat roles and the names of the tools
 * themselves. Compared case-insensitively, whole value only.
 */
export const KEEP_WORDS: readonly string[] = [
  // Titles: kept so a name's parts never mask "Mr" or "Dr" everywhere.
  "mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam", "mister",
  "г-н", "г-жа", "господин", "госпожа", "доктор", "профессор",
  // Generic organisation words.
  "team", "support", "company", "inc", "llc", "ltd", "corp", "bank", "school",
  "hospital", "clinic", "university", "office", "department", "hr", "it",
  "sales", "marketing", "legal", "finance", "management", "customer service",
  "команда", "поддержка", "компания", "банк", "школа", "больница", "клиника",
  "университет", "офис", "отдел", "бухгалтерия", "отдел кадров", "руководство",
  "ооо", "ао", "пао", "зао", "ип",
  // Chat roles and the tools themselves.
  "user", "assistant", "system", "пользователь", "ассистент",
  "atomic agent", "atomic", "claude", "chatgpt", "openai", "anthropic",
  "google", "gmail", "microsoft", "apple", "github", "telegram", "discord",
];

const KEEP = new Set(KEEP_WORDS);

/** One word of a name worth masking on its own: a capital, then letters, `'` or `-`. */
const NAME_PART = /^\p{Lu}[\p{L}'’-]+$/u;

function kept(value: string): boolean {
  return KEEP.has(value.toLocaleLowerCase());
}

/** An organisation written with no capital letter and no digit: an ordinary word. */
function plainWordOrg(found: ModelFoundValue): boolean {
  return found.kind === "ORG" && !/[\p{Lu}\p{N}]/u.test(found.value);
}

/**
 * `found` without ordinary words, with each multi-word name followed by
 * its capitalised parts. Order is kept (a name's parts come right after
 * it) and every value appears once.
 */
export function refineFoundValues(found: readonly ModelFoundValue[]): ModelFoundValue[] {
  const out: ModelFoundValue[] = [];
  const seen = new Set<string>();
  const push = (entry: ModelFoundValue): void => {
    if (seen.has(entry.value)) return;
    seen.add(entry.value);
    out.push(entry);
  };
  for (const entry of found) {
    if (kept(entry.value) || plainWordOrg(entry)) continue;
    push(entry);
    if (entry.kind !== "NAME") continue;
    const parts = entry.value.split(/\s+/);
    if (parts.length < 2) continue;
    for (const part of parts) {
      if (NAME_PART.test(part) && !kept(part)) push({ value: part, kind: "NAME" });
    }
  }
  return out;
}
