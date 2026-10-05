/**
 * Deterministic grounding guard for end-of-turn reflection.
 *
 * Reflection asks a (often small, local) model to extract durable facts
 * from the last exchange. Small models hallucinate: they copy example
 * values out of the reflection prompt, echo the prompt's own framing
 * back as a "fact" ("you are my personal assistant"), and promote a
 * one-turn instruction ("Reply exactly LOCAL_OK. Do not use tools.")
 * into a lasting preference. The prompt tells them not to; this module
 * makes sure it does not matter when they do anyway.
 *
 * Two independent, deliberately narrow checks:
 *
 *  1. `isTrivialReflectionWindow` — runs BEFORE the LLM call. A window
 *     whose user side is nothing but pings / greetings / literal echo
 *     probes / one-off tool or format restrictions has nothing durable
 *     to extract, so the call is skipped entirely. Any sign of lasting
 *     intent ("remember", "always", "from now on", …) or of the user
 *     talking about themselves ("I", "my", "я", "мой", …) disables the
 *     skip, and so does a bare confirmation ("yes", "да", "ok") — it may
 *     be the answer to "shall I remember that?".
 *
 *  2. `filterUngroundedReflection` — runs AFTER parsing, before any
 *     write. Drops a SET / NOTE when:
 *       - it claims a name for the user (a `name`-like SET key, "my name
 *         is X", "call me X", "the user's name is X", or a clause-final
 *         "I am X" / "I am X and …") and the name never appears in the
 *         user's own messages in the reflected window (a name already
 *         stored in the profile does NOT count — it may itself have
 *         been invented);
 *       - it describes the assistant itself ("you are my personal
 *         assistant", "I'm your AI assistant");
 *       - it repeats the literal payload of a one-off echo instruction
 *         ("LOCAL_OK") from the same window;
 *       - it turns a one-off "do not use tools" into a tool preference
 *         when the user never said it should last.
 *
 * Known false-negative risk (a real fact being dropped), kept small on
 * purpose:
 *  - A name the user only *confirmed* ("Is your name Alex?" — "yes")
 *    never appears in the user's own words, so an identity claim built
 *    on it is dropped.
 *  - Name matching is fuzzy (romanisation, Russian case endings, edit
 *    distance) but not exhaustive; an unusual romanisation of a
 *    Cyrillic name may miss.
 *  - Short Latin names (≤ 4 letters after normalisation) must match a
 *    user word exactly, so "Sam" is not vouched for by "same" — and a
 *    user who wrote "Samm" will not get "Sam" either.
 *  - A real name the user gave in an earlier turn outside the reflected
 *    window is not restated: a note "Nadia moved to Lisbon" written
 *    from a later turn is dropped if it phrases the name as an identity
 *    claim. The stored `name` fact itself is untouched.
 *  - A one-off probe is lifted only by a marker in the same clause or a
 *    marker-only clause right before it ("Запомни, отвечай только
 *    JSON"); "Always: reply only JSON" phrased differently may still be
 *    treated as one-off.
 * The opposite risk (an invented name slipping through) exists where
 * matching is loose on purpose: stems of name-like Russian words
 * (capitalised, or right after "зови меня" / "меня зовут" / "я" — so a
 * sentence-initial «Данные» still vouches for "Dan"), "The user is X"
 * where X ends like a demonym ("Ivan", "Dmitri" are not checked), and
 * names written in a script other than Latin / Cyrillic, which fail
 * open.
 * Everything that is not an identity claim, assistant persona, echo
 * payload or one-off tool restriction passes through untouched.
 */

import { isNameProfileKey } from "../profile-name-keys.js";
import type { NameGroundingStatus } from "../profile-name-keys.js";
import type { ReflectionFact, ReflectionNote } from "./reflection-parser.js";

/** Why a parsed reflection item was rejected. */
export type UngroundedReason =
  | "ungrounded_identity"
  | "assistant_persona"
  | "one_off_payload"
  | "one_off_tool_restriction";

export interface DroppedReflectionItem {
  kind: "fact" | "note";
  reason: UngroundedReason;
  text: string;
}

export interface GroundingContext {
  /**
   * The user's own messages for the reflected window (oldest first).
   * The ONLY grounding source. Stored profile values are deliberately
   * not accepted: a name an earlier reflection invented would vouch for
   * itself forever (field case: `name=Анна`, never typed by the user,
   * re-written as `name=Anna`).
   */
  userTexts: readonly string[];
}

export interface GroundedReflection {
  facts: ReflectionFact[];
  notes: ReflectionNote[];
  dropped: DroppedReflectionItem[];
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Explicit persistence markers: the user says something should last.
 * These — and only these — lift the one-off gates (tool restriction,
 * echo payload). Pronouns do not: "Do not use tools, I'm testing" is
 * still a one-off.
 */
const PERSISTENCE_WORDS: ReadonlySet<string> = new Set([
  "remember",
  "always",
  "never",
  "default",
  "prefer",
  "prefers",
  "henceforth",
  "запомни",
  "запомните",
  "помни",
  "всегда",
  "никогда",
  "отныне",
  "впредь",
  "умолчанию",
  "предпочитаю",
]);

const PERSISTENCE_PHRASES: readonly RegExp[] = [
  /\bfrom now on\b/,
  /\bgoing forward\b/,
  /\bnext time\b/,
  /\bevery time\b/,
  /\beach time\b/,
  /\bin (?:the )?future\b/,
  /\bby default\b/,
  /с этого момента/,
  /в следующий раз/,
  /каждый раз/,
];

/**
 * The user talking about themselves. Only used to keep a window from
 * being skipped as trivial — never to lift a one-off gate.
 */
const PERSONAL_WORDS: ReadonlySet<string> = new Set([
  "my",
  "mine",
  "me",
  "i",
  "i'm",
  "im",
  "i've",
  "i'd",
  "i'll",
  "we",
  "our",
  "us",
  "я",
  "меня",
  "мне",
  "мой",
  "моя",
  "моё",
  "мое",
  "мои",
  "мы",
  "наш",
  "наша",
  "наши",
]);

function lower(s: string): string {
  return s.toLowerCase();
}

function wordTokens(text: string): string[] {
  return lower(text).match(/[\p{L}\p{N}_'’]+/gu)?.map((t) => t.replace(/’/g, "'")) ?? [];
}

function hasPersistenceMarker(text: string): boolean {
  // "Never mind" dismisses; it does not ask for anything to last.
  const lowered = lower(text).replace(/\bnever\s*mind\b/g, " ");
  for (const token of wordTokens(lowered)) {
    if (PERSISTENCE_WORDS.has(token)) return true;
  }
  return PERSISTENCE_PHRASES.some((re) => re.test(lowered));
}

/**
 * A fragment that is nothing but a persistence marker — "Запомни",
 * "From now on", "Remember", "Отныне" — and so scopes the fragment
 * right after it ("Запомни, отвечай только JSON").
 */
const MARKER_ONLY_FRAGMENT =
  /^(?:please\s+|пожалуйста\s+)?(?:remember(?: this| that)?|from now on|going forward|henceforth|by default|always|in (?:the )?future|запомни(?:те)?(?: это| что)?|помни|отныне|впредь|всегда|по умолчанию|с этого момента)\s*:?$/;

function isMarkerOnlyFragment(fragment: string): boolean {
  return MARKER_ONLY_FRAGMENT.test(lower(fragment).replace(/\s+/g, " ").trim());
}

function hasPersonalMarker(text: string): boolean {
  for (const token of wordTokens(text)) {
    if (PERSONAL_WORDS.has(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Probe fragments
// ---------------------------------------------------------------------------

/** Prepositions that turn "reply only X" into a style rule, not an echo. */
const STYLE_PREPOSITIONS: ReadonlySet<string> = new Set([
  "in",
  "with",
  "using",
  "as",
  "like",
  "to",
  "when",
  "for",
  "about",
  "on",
  "from",
  "by",
  "without",
  "after",
  "before",
  "if",
  "на",
  "по",
  "в",
  "с",
  "как",
  "когда",
  "без",
]);

const ECHO_WITH_QUALIFIER =
  /^(?:reply|respond|answer|say|output|print|return|type|write|repeat|echo|ответь|ответьте|отвечай|скажи|скажите|напиши|напишите|выведи|верни|повтори)(?:\s+back)?(?:\s+with)?(?:\s+(?:exactly|only|just|verbatim|precisely|literally|ровно|только|просто|строго|дословно))+\s*:?\s+(.+)$/;

const ECHO_BARE = /^(?:say|echo|repeat|скажи|повтори)\s*:?\s+(.+)$/;

const ECHO_PAYLOAD_TRAILER =
  /\s+(?:and nothing else|nothing else|only|exactly|verbatim|и больше ничего|только)$/;

/** Words that make an echo payload a ping-style literal ("say pong"). */
const LITERAL_PAYLOAD_WORDS: ReadonlySet<string> = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "or",
  "pong",
  "ping",
  "ready",
  "done",
  "hi",
  "hello",
  "test",
  "true",
  "false",
  "ок",
  "да",
  "нет",
  "или",
  "готово",
  "привет",
  "понг",
  "пинг",
]);

const TOOL_RESTRICTION =
  /^(?:(?:please\s+)?(?:do not|don't|dont|no need to|you don't need to|without)\s+(?:use|using|call|calling|run|running|invoke|invoking)?\s*(?:any\s+)?|no\s+)(?:tools?|tool calls?|functions?|function calls?|commands?)(?:\s+(?:for this|here|now|this time|in this reply|in your reply|for this reply|please))?$/;

const TOOL_RESTRICTION_RU =
  /^(?:не\s+(?:используй|используйте|вызывай|вызывайте|применяй|запускай)\s+(?:никакие\s+|никаких\s+)?|без\s+)(?:инструменты|инструментов|тулы|тулов|тулзы|функции|функций|команды|команд)$/;

const FORMAT_ONLY =
  /^(?:(?:no|without)\s+(?:explanations?|extra text|other text|additional text|markdown|formatting|punctuation|quotes|commentary|comments)|nothing else|and nothing else|only that|that's it|that is all|one word|in one word|без пояснений|без объяснений|ничего больше|больше ничего)$/;

/**
 * Whole-fragment pings and greetings. Confirmations ("yes", "ok", "да",
 * "хорошо") are deliberately NOT here: they may answer the assistant's
 * "shall I remember that you're vegetarian?", and that turn must still
 * be reflected.
 */
const PING_FRAGMENTS: ReadonlySet<string> = new Set([
  "hi",
  "hello",
  "hey",
  "yo",
  "ping",
  "test",
  "testing",
  "test test",
  "just testing",
  "this is a test",
  "is this working",
  "are you there",
  "are you alive",
  "thanks",
  "thank you",
  "thx",
  "привет",
  "здравствуй",
  "здравствуйте",
  "тест",
  "проверка",
  "пинг",
  "спасибо",
]);

const LEADING_FILLER = /^(?:please|pls|plz|now|just|пожалуйста|просто|теперь)[,\s]+/;

const QUOTE_OPEN = /^["'`«“‘]/;

type ProbeKind = "echo" | "tool_restriction" | "format" | "ping";

interface ProbeFragment {
  kind: ProbeKind;
  /** Raw payload for echo fragments (original casing, quotes stripped). */
  payload?: string;
}

/** Split a user message into clause-sized fragments. */
function splitFragments(text: string): string[] {
  return text
    .split(/[.!?;\n]+|,\s+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`«“‘]+|["'`»”’]+$/g, "").trim();
}

/**
 * An echo payload counts as a probe only when it looks literal: quoted,
 * containing `_` or a digit, carrying an ALL-CAPS token, or made of
 * ping words ("pong", "yes or no"). "Answer only briefly", "Отвечай
 * только по-русски" and "Reply only English please" are style rules.
 */
function isLiteralPayload(quoted: boolean, payload: string): boolean {
  if (quoted) return true;
  if (/[_\d]/.test(payload)) return true;
  const tokens = payload.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (
    tokens.some(
      (t) => t.length >= 2 && t === t.toUpperCase() && /\p{Lu}/u.test(t),
    )
  ) {
    return true;
  }
  return tokens.length > 0 && tokens.every((t) => LITERAL_PAYLOAD_WORDS.has(lower(t)));
}

function classifyFragment(original: string): ProbeFragment | null {
  let f = lower(original).replace(/’/g, "'").replace(/\s+/g, " ").trim();
  // Strip leading filler words, possibly several ("please just …").
  for (let i = 0; i < 3; i += 1) {
    const next = f.replace(LEADING_FILLER, "");
    if (next === f) break;
    f = next;
  }
  if (f.length === 0) return { kind: "ping" };
  if (PING_FRAGMENTS.has(f)) return { kind: "ping" };
  if (TOOL_RESTRICTION.test(f) || TOOL_RESTRICTION_RU.test(f)) {
    return { kind: "tool_restriction" };
  }
  if (FORMAT_ONLY.test(f)) return { kind: "format" };
  const echo = ECHO_WITH_QUALIFIER.exec(f) ?? ECHO_BARE.exec(f);
  if (!echo) return null;
  const rawPayload = echo[1]!.replace(ECHO_PAYLOAD_TRAILER, "").trim();
  const quoted = QUOTE_OPEN.test(rawPayload);
  const payloadLower = stripQuotes(rawPayload);
  const payloadWords = payloadLower.split(/\s+/).filter((w) => w.length > 0);
  // A short payload with no preposition ("only in Russian", "only tests
  // for new code" are scope rules) …
  if (
    payloadWords.length < 1 ||
    payloadWords.length > 3 ||
    payloadWords.some((w) => STYLE_PREPOSITIONS.has(w))
  ) {
    return null;
  }
  // … recovered in its original casing …
  const idx = lower(original).lastIndexOf(payloadLower);
  const payload =
    idx >= 0 ? original.slice(idx, idx + payloadLower.length) : payloadLower;
  // … that looks like a literal, not a style word.
  if (!isLiteralPayload(quoted, payload)) return null;
  return { kind: "echo", payload };
}

/**
 * `true` when every user message in the window is made only of probe
 * fragments — literal echo commands ("reply exactly LOCAL_OK"), one-off
 * tool or format restrictions ("do not use tools", "no explanation"),
 * or pings / greetings ("hi", "ping", "thanks") — and nothing hints at
 * a lasting preference or a statement about the user. An empty window
 * is trivial too.
 *
 * Narrow by design: a single unrecognised clause ("what's the capital
 * of France?", "да") makes the window non-trivial and reflection runs
 * as before.
 */
export function isTrivialReflectionWindow(userTexts: readonly string[]): boolean {
  for (const text of userTexts) {
    if (hasPersistenceMarker(text) || hasPersonalMarker(text)) return false;
    for (const fragment of splitFragments(text)) {
      if (classifyFragment(fragment) === null) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Post-parse grounding filter
// ---------------------------------------------------------------------------

/**
 * Explicit naming phrases. Every capitalised word after one of these is
 * a claimed name for the USER. Longer alternatives come first. A bare
 * "the user is X" is deliberately absent: "The user is Brazilian" /
 * "Russian-speaking" are attributes, not names.
 */
const NAMED_LEAD =
  /(?:^|[^\p{L}])(my name is|my name's|call me|remember me as|refer to me as|address me as|user is named|user is called|user is known as|user's name is|users name is|user name is|меня зовут|зови меня|называй меня)\s+([^\s,.;:!?]+)(?:\s+([^\s,.;:!?]+))?/giu;

/**
 * First-person "I am X" counts only when X (plus an optional
 * capitalised surname) ends the clause or is followed by "and" — so
 * "I am Alex and you are my assistant" is a claim, "I am Brazilian and
 * live in Rio" is checked too (and grounded by "Brazil"), but "I am
 * Working on …" is not. No `i` flag: `\p{Lu}` would match lowercase
 * under case folding. "and" must follow whitespace, so a backtracked
 * partial word ("Br" + "and new") can never satisfy the lookahead.
 */
const FIRST_PERSON_LEAD =
  /(?:^|[^\p{L}])(?:I am|I'm|Im|i am|i'm)\s+([^\s,.;:!?]+)(?:\s+(\p{Lu}[^\s,.;:!?]*))?(?=\s*(?:$|[,.;:!?)])|\s+and\b)/gu;

/**
 * Third-person "The user is Alex." — the form the prompt now asks for.
 * Counted only for a single capitalised, unhyphenated token that ends
 * the clause or is followed by "and" (a hyphen fails the lookahead, so
 * "Russian-speaking" is never captured); demonyms are filtered out in
 * `claimedNames` so "Brazilian" / "Russian" stay attributes.
 */
const USER_IS_LEAD =
  /(?:^|[^\p{L}])[Uu]ser is\s+(\p{Lu}[\p{L}'’]*)(?=\s*(?:$|[,.;:!?)])|\s+and\b)/gu;

/** Demonym / adjective endings: "Brazilian", "Japanese", "Polish", "Israeli", "Slavic". */
const DEMONYM_SUFFIX = /(?:an|ian|ese|ish|i|ic)$/i;

/** Capitalised words that follow a lead without being a name. */
const NON_NAME_CAPITALISED: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "not",
  "also",
  "in",
  "at",
  "on",
  "from",
  "using",
  "working",
  "going",
  "trying",
  "looking",
  "currently",
  "still",
  "very",
  "so",
  "here",
  "back",
  "your",
  "you",
  "it",
  "this",
  "that",
  "fine",
  "ready",
  "done",
  "sorry",
]);

/**
 * The assistant describing itself, usually the reflection prompt's own
 * framing ("a memory extractor for a personal assistant") echoed back.
 * The phrase must end the clause, so "you are my assistant for the
 * Berlin trip" or "I am an AI researcher" do not match.
 */
const PERSONA_END = String.raw`(?=\s*(?:$|[,.;:!?)]|and\b|but\b|who\b|that\b))`;
const ASSISTANT_PERSONA: readonly RegExp[] = [
  new RegExp(
    String.raw`\byou(?: are|'re) (?:my|a|an|the|our)\s+(?:personal\s+|ai\s+|helpful\s+|virtual\s+|local\s+)*(?:assistant|ai|agent|chatbot|bot)\b` +
      PERSONA_END,
    "i",
  ),
  new RegExp(
    String.raw`\bi(?: am|'m) (?:an?\s+|the\s+|your\s+)?(?:personal\s+|ai\s+|helpful\s+|virtual\s+)*(?:ai|assistant|language model|llm|chatbot|memory extractor)\b` +
      PERSONA_END,
    "i",
  ),
  /\bmemory extractor\b/i,
  // "As an AI, I …" at the start of a clause — not "works as an AI engineer".
  /(?:^|[.!?]\s+)as an ai(?: language model| assistant)?\s*,/i,
];

const TOOL_MENTION = /\btool(?:s|ing)?\b|\btool[-_ ]?(?:use|usage|calls?)\b|инструмент/i;
const TOOL_AVOIDANCE =
  /\b(?:avoid|avoids|avoiding|not|no|never|without|don't|doesn't|instead|prefer|prefers|preferred|dislike|dislikes|disable|disabled|minimi[sz]e)\b|не\s|без\s/i;

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
};

function transliterate(s: string): string {
  let out = "";
  for (const ch of s) out += CYRILLIC_TO_LATIN[ch] ?? ch;
  return out;
}

/**
 * Loose phonetic key so "Nadia" / "Nadya" / "Надя", "Yelena" / "Елена",
 * "Julia" / "Юля" compare equal-ish.
 */
function looseKey(word: string): string {
  return transliterate(lower(word))
    .replace(/[^a-z0-9]/g, "")
    .replace(/x/g, "ks")
    .replace(/j/g, "y")
    .replace(/w/g, "v")
    .replace(/ph/g, "f")
    .replace(/ia/g, "ya")
    .replace(/^ye/, "e")
    .replace(/^yu/, "u")
    .replace(/(.)\1+/g, "$1");
}

/** Russian case endings, longest first ("Надей", "Сашей", "Алексом", "Димой"). */
const RU_CASE_ENDINGS: readonly string[] = [
  "ой",
  "ей",
  "ом",
  "ем",
  "ам",
  "ям",
  "ою",
  "ею",
  "у",
  "ю",
  "е",
  "ы",
  "и",
  "а",
  "я",
  "ь",
];

function cyrillicStems(token: string): string[] {
  const lowered = lower(token);
  const out: string[] = [];
  for (const ending of RU_CASE_ENDINGS) {
    if (lowered.endsWith(ending) && lowered.length - ending.length >= 3) {
      out.push(lowered.slice(0, lowered.length - ending.length));
    }
  }
  return out;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** Letters outside Latin / Cyrillic — names there cannot be compared. */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Cyrillic}])\p{L}/u;
const OTHER_SCRIPT_GLOBAL = /(?![\p{Script=Latin}\p{Script=Cyrillic}])\p{L}/gu;

/**
 * Below this many foreign-script letters in the user's messages, the
 * window still counts as comparable — a stray "µ" or "é"-like symbol
 * must not switch the identity check off.
 */
const OTHER_SCRIPT_MIN_LETTERS = 3;

interface VocabEntry {
  /** Lower-cased token as typed. */
  raw: string;
  /** `looseKey` of the token. */
  key: string;
  /**
   * Fuzzy matching (edit distance) is allowed only from tokens that can
   * plausibly be names: capitalised, or a Russian word right after a
   * naming lead.
   * A lower-case Latin word ("same", "make", "been") never vouches for a
   * name it merely resembles.
   */
  fuzzy: boolean;
  /** Cyrillic source — eligible for the case-ending prefix rule. */
  cyrillic: boolean;
}

interface Vocabulary {
  entries: VocabEntry[];
  /** When true, the identity check cannot verify and fails open. */
  unverifiable: boolean;
}

/** Two-word Russian naming leads ("зови меня Надей", "меня зовут Надя"). */
const RU_NAMING_LEADS_2: ReadonlySet<string> = new Set([
  "зови меня",
  "называй меня",
  "меня зовут",
  "звать меня",
  "мое имя",
  "моё имя",
]);

/** `true` when `tokens[i]` directly follows a Russian naming lead. */
function followsRuNamingLead(tokens: readonly string[], i: number): boolean {
  const prev1 = i >= 1 ? lower(tokens[i - 1]!) : "";
  const prev2 = i >= 2 ? lower(tokens[i - 2]!) : "";
  if (prev1 === "я") return true;
  return RU_NAMING_LEADS_2.has(`${prev2} ${prev1}`);
}

function buildVocabulary(ctx: GroundingContext): Vocabulary {
  const entries: VocabEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: VocabEntry): void => {
    if (entry.key.length === 0) return;
    const id = `${entry.raw}|${entry.key}|${entry.fuzzy}|${entry.cyrillic}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push(entry);
  };
  let otherScriptLetters = 0;
  const addText = (text: string): void => {
    otherScriptLetters += text.match(OTHER_SCRIPT_GLOBAL)?.length ?? 0;
    const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      const cyrillic = /\p{Script=Cyrillic}/u.test(token);
      // Name-like: capitalised, or right after a
      // Russian naming lead ("зови меня надей"). Ordinary lower-case
      // words — Latin "same"/"make" or Russian «данные»/«макет»/«алерты» —
      // only ever match exactly, never fuzzily or by stem.
      const nameLike =
        /^\p{Lu}/u.test(token) || (cyrillic && followsRuNamingLead(tokens, i));
      add({
        raw: lower(token),
        key: looseKey(token),
        fuzzy: nameLike,
        cyrillic: cyrillic && nameLike,
      });
      if (cyrillic && nameLike) {
        for (const stem of cyrillicStems(token)) {
          add({ raw: stem, key: looseKey(stem), fuzzy: true, cyrillic: true });
        }
      }
    }
  };
  for (const text of ctx.userTexts) addText(text);
  return { entries, unverifiable: otherScriptLetters >= OTHER_SCRIPT_MIN_LETTERS };
}

function isGrounded(word: string, vocab: Vocabulary): boolean {
  const raw = lower(word).replace(/[^\p{L}\p{N}]/gu, "");
  const key = looseKey(word);
  if (key.length === 0 || raw.length === 0) return true;
  // One edit for short names, two for longer ones: enough for
  // romanisation drift (Nadia/Nadya, Yevgeny/Евгений) without letting an
  // unrelated user word ("alerts") vouch for an invented "Alex".
  const tolerance = key.length <= 5 ? 1 : 2;
  for (const entry of vocab.entries) {
    if (entry.raw === raw) return true;
    // Normalised spelling: always from a name-like token, and from any
    // token once the name is long enough not to collide with a common
    // word ("Sam"/"same", "Ben"/"been" stay apart).
    if (entry.key === key && (entry.fuzzy || key.length >= 5)) return true;
    // The user wrote the root, the model the derived form: "Brazil" →
    // "Brazilian", "Russia" → "Russian".
    if (entry.key.length >= 5 && key.startsWith(entry.key)) return true;
    if (!entry.fuzzy) continue;
    // Russian case forms / stems: "Надей" → "над" vs "Nadya", "Сашей" →
    // "саш" vs "Sasha", "Димой" → "дим" vs "Dima".
    if (
      entry.cyrillic &&
      entry.key.length >= 3 &&
      commonPrefixLength(entry.key, key) >= Math.max(3, key.length - 2)
    ) {
      return true;
    }
    if (key.length < 5) continue;
    if (entry.key.length < 3) continue;
    if (entry.key[0] !== key[0]) continue;
    if (Math.abs(entry.key.length - key.length) > tolerance) continue;
    if (editDistance(entry.key, key) <= tolerance) return true;
  }
  return false;
}

function startsUppercase(word: string): boolean {
  return /^\p{Lu}/u.test(word);
}

function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Capitalised name parts of one claimed word, split on hyphens so
 * "Russian-speaking" checks only "Russian" and "Anne-Marie" checks both.
 */
function namePartsOf(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[-‐–]/)) {
    const word = cleanWord(part);
    if (word.length < 2) continue;
    if (!startsUppercase(word)) continue;
    if (NON_NAME_CAPITALISED.has(lower(word))) continue;
    out.push(word);
  }
  return out;
}

/** Names this text claims for the user ("call me Sam", "I am Alex."). */
function claimedNames(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(NAMED_LEAD)) {
    const first = match[2];
    if (!first || !startsUppercase(cleanWord(first))) continue;
    out.push(...namePartsOf(first));
    const second = match[3];
    if (second && startsUppercase(cleanWord(second))) out.push(...namePartsOf(second));
  }
  for (const match of text.matchAll(FIRST_PERSON_LEAD)) {
    const first = match[1];
    if (!first || !startsUppercase(cleanWord(first))) continue;
    out.push(...namePartsOf(first));
    if (match[2]) out.push(...namePartsOf(match[2]));
  }
  for (const match of text.matchAll(USER_IS_LEAD)) {
    const word = cleanWord(match[1] ?? "");
    if (word.length < 2 || DEMONYM_SUFFIX.test(word)) continue;
    if (NON_NAME_CAPITALISED.has(lower(word))) continue;
    out.push(word);
  }
  return out;
}

function nameValueWords(value: string): string[] {
  return value
    .split(/[\s_-]+/)
    .map(cleanWord)
    .filter((w) => w.length >= 2 && /\p{L}/u.test(w));
}

interface OneOffSignals {
  payloadTokens: string[];
  toolRestriction: boolean;
}

/**
 * Collect the one-off instructions seen in messages that carry no
 * explicit persistence marker ("remember", "always", "from now on",
 * "запомни", …):
 *  - echo payload tokens worth matching ("LOCAL_OK"). Only distinctive
 *    tokens qualify — containing `_` / a digit, or all-caps and at
 *    least 4 letters — and only when the user never used the token
 *    outside the echo command itself;
 *  - whether a one-off tool restriction ("do not use tools") appeared.
 * "From now on, reply only JSON" and "Remember: do not use tools" lift
 * both gates; "Do not use tools, I'm testing" does not.
 */
function collectOneOffSignals(userTexts: readonly string[]): OneOffSignals {
  const payloadCounts = new Map<string, number>();
  let toolRestriction = false;
  for (const text of userTexts) {
    const fragments = splitFragments(text);
    for (let i = 0; i < fragments.length; i += 1) {
      const fragment = fragments[i]!;
      const probe = classifyFragment(fragment);
      if (!probe) continue;
      // Persistence is decided per fragment, not per message: "Reply
      // exactly OK, no tools, I prefer quick answers" keeps "no tools"
      // one-off. A probe is lasting only when it carries a marker
      // itself or directly follows a marker-only fragment
      // ("Запомни, отвечай только JSON", "From now on, reply only JSON").
      const previous = i > 0 ? fragments[i - 1]! : null;
      if (
        hasPersistenceMarker(fragment) ||
        (previous !== null && isMarkerOnlyFragment(previous))
      ) {
        continue;
      }
      if (probe.kind === "tool_restriction") toolRestriction = true;
      if (probe.kind === "echo" && probe.payload) {
        for (const token of probe.payload.match(/[\p{L}\p{N}_]+/gu) ?? []) {
          const distinctive =
            (token.length >= 3 && /[_\d]/.test(token)) ||
            (token.length >= 4 && token === token.toUpperCase() && /\p{Lu}/u.test(token));
          if (!distinctive) continue;
          const key = lower(token);
          payloadCounts.set(key, (payloadCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const payloadTokens: string[] = [];
  for (const [token, inEcho] of payloadCounts) {
    let total = 0;
    for (const text of userTexts) {
      for (const t of lower(text).match(/[\p{L}\p{N}_]+/gu) ?? []) {
        if (t === token) total += 1;
      }
    }
    if (total <= inEcho) payloadTokens.push(token);
  }
  return { payloadTokens, toolRestriction };
}

function containsToken(text: string, token: string): boolean {
  const tokens: readonly string[] = lower(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.includes(token);
}

function judge(
  rawText: string,
  nameWords: readonly string[],
  vocab: Vocabulary,
  oneOff: OneOffSignals,
  userTextLower: string,
): UngroundedReason | null {
  const text = rawText.replace(/’/g, "'");
  // Assistant persona ("you are my personal assistant") — unless the
  // user literally wrote that phrase.
  for (const re of ASSISTANT_PERSONA) {
    const hit = re.exec(text);
    if (hit && !userTextLower.includes(lower(hit[0]).trim())) return "assistant_persona";
  }
  if (!vocab.unverifiable) {
    for (const word of [...nameWords, ...claimedNames(text)]) {
      // A name written in a script we cannot compare fails open.
      if (OTHER_SCRIPT.test(word)) continue;
      if (!isGrounded(word, vocab)) return "ungrounded_identity";
    }
  }
  for (const token of oneOff.payloadTokens) {
    if (containsToken(text, token)) return "one_off_payload";
  }
  if (oneOff.toolRestriction && TOOL_MENTION.test(text) && TOOL_AVOIDANCE.test(text)) {
    return "one_off_tool_restriction";
  }
  return null;
}

/**
 * Drop parsed SET facts / NOTE bodies that are not supported by the
 * user's own words. See the module header for the exact rules and
 * their false-negative risk. Pure: never touches a store.
 */
export function filterUngroundedReflection(
  parsed: {
    facts: readonly ReflectionFact[];
    notes: readonly ReflectionNote[];
  },
  ctx: GroundingContext,
): GroundedReflection {
  const vocab = buildVocabulary(ctx);
  const oneOff = collectOneOffSignals(ctx.userTexts);
  const userTextLower = lower(ctx.userTexts.join("\n").replace(/’/g, "'"));
  const dropped: DroppedReflectionItem[] = [];
  const facts: ReflectionFact[] = [];
  for (const fact of parsed.facts) {
    const text = `${fact.key.replace(/_/g, " ")} ${fact.value}`;
    const nameWords = isNameProfileKey(fact.key) ? nameValueWords(fact.value) : [];
    const reason = judge(text, nameWords, vocab, oneOff, userTextLower);
    if (reason) {
      dropped.push({ kind: "fact", reason, text: `${fact.key}=${fact.value}` });
      continue;
    }
    facts.push(fact);
  }
  const notes: ReflectionNote[] = [];
  for (const note of parsed.notes) {
    const reason = judge(note.body, [], vocab, oneOff, userTextLower);
    if (reason) {
      dropped.push({ kind: "note", reason, text: note.body });
      continue;
    }
    notes.push(note);
  }
  return { facts, notes, dropped };
}

/**
 * ATO-199. How the name in a profile value (`name`, `full_name`, …)
 * compares with `texts` — the user's own messages, never stored profile
 * values or notes. `grounded` when every word of it is vouched for,
 * `ungrounded` when one is not, `unverifiable` when a word cannot be
 * compared (it, or the user's writing, is in a script other than Latin /
 * Cyrillic) and nothing contradicts it, or when it has no word to
 * compare at all. Same matching as the reflection
 * filter, so a value reflection keeps is a value this calls grounded.
 */
export function nameGroundingIn(
  value: string,
  texts: readonly string[],
): NameGroundingStatus {
  const vocab = buildVocabulary({ userTexts: texts });
  const words = nameValueWords(value);
  // Nothing to compare ("J", digits): no verdict either way.
  if (words.length === 0) return "unverifiable";
  let unverifiable = false;
  for (const word of words) {
    if (OTHER_SCRIPT.test(word) || vocab.unverifiable) {
      unverifiable = true;
      continue;
    }
    if (!isGrounded(word, vocab)) return "ungrounded";
  }
  return unverifiable ? "unverifiable" : "grounded";
}
