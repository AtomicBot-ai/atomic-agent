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
 *     whose user side is nothing but probe / echo / ping / one-off
 *     format instructions has nothing durable to extract, so the call
 *     is skipped entirely. Any sign of lasting intent ("remember",
 *     "always", "from now on", first-person statements, …) disables
 *     the skip.
 *
 *  2. `filterUngroundedReflection` — runs AFTER parsing, before any
 *     write. Drops a SET / NOTE when:
 *       - it asserts the user's identity (name, "I am X", "call me X",
 *         a `name`-like SET key) and the claimed name never appears in
 *         the user's own messages (or in a name already stored in the
 *         profile);
 *       - it describes the assistant itself ("you are my personal
 *         assistant", "I am an AI");
 *       - it repeats the payload of a one-off echo instruction
 *         ("LOCAL_OK") from the same window;
 *       - it turns a one-off "do not use tools" into a tool preference
 *         when the user never said it should last.
 *
 * Known false-negative risk (a real fact being dropped), kept small on
 * purpose:
 *  - A name the user only *confirmed* ("Is your name Alex?" — "yes")
 *    never appears in the user's own words, so an identity claim built
 *    on it is dropped.
 *  - A name written in a script other than Latin or Cyrillic cannot be
 *    compared, so the identity check fails open (keeps the item) when
 *    the user wrote in such a script.
 *  - Transliteration is fuzzy (edit distance), not exact; unusual
 *    romanisations of a Cyrillic name may miss.
 * Everything that is not an identity claim, assistant persona, echo
 * payload or one-off tool restriction passes through untouched.
 */

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
  /** The user's own messages for the reflected window (oldest first). */
  userTexts: readonly string[];
  /**
   * Names already stored in the profile (values of `name`-like keys).
   * They count as grounded so a note that restates a known name is not
   * dropped just because this turn did not repeat it.
   */
  knownNames?: readonly string[];
}

export interface GroundedReflection {
  facts: ReflectionFact[];
  notes: ReflectionNote[];
  dropped: DroppedReflectionItem[];
}

// ---------------------------------------------------------------------------
// Trivial-window detection
// ---------------------------------------------------------------------------

/**
 * Single words / short phrases that signal the user wants something to
 * last, or is talking about themselves. Any hit disables the trivial
 * skip. Matched against lower-cased word tokens (Unicode-aware, so the
 * Cyrillic entries work).
 */
const DURABLE_WORDS: ReadonlySet<string> = new Set([
  // English
  "remember",
  "always",
  "never",
  "default",
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
  "prefer",
  "preference",
  "future",
  "forward",
  "henceforth",
  // Russian
  "запомни",
  "запомните",
  "помни",
  "всегда",
  "никогда",
  "отныне",
  "впредь",
  "умолчанию",
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
  "предпочитаю",
]);

const DURABLE_PHRASES: readonly RegExp[] = [
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

const TOOL_RESTRICTION =
  /^(?:(?:please\s+)?(?:do not|don't|dont|no need to|you don't need to|without)\s+(?:use|using|call|calling|run|running|invoke|invoking)?\s*(?:any\s+)?|no\s+)(?:tools?|tool calls?|functions?|function calls?|commands?)(?:\s+(?:for this|here|now|this time|in this reply|in your reply|for this reply|please))?$/;

const TOOL_RESTRICTION_RU =
  /^(?:не\s+(?:используй|используйте|вызывай|вызывайте|применяй|запускай)\s+(?:никакие\s+|никаких\s+)?|без\s+)(?:инструменты|инструментов|тулы|тулов|тулзы|функции|функций|команды|команд)$/;

const FORMAT_ONLY =
  /^(?:(?:no|without)\s+(?:explanations?|extra text|other text|additional text|markdown|formatting|punctuation|quotes|commentary|comments)|nothing else|and nothing else|only that|that's it|that is all|one word|in one word|без пояснений|без объяснений|ничего больше|больше ничего)$/;

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
  "ok",
  "okay",
  "k",
  "thanks",
  "thank you",
  "thx",
  "cool",
  "nice",
  "great",
  "sure",
  "yes",
  "no",
  "привет",
  "здравствуй",
  "здравствуйте",
  "тест",
  "проверка",
  "пинг",
  "спасибо",
  "ок",
  "окей",
  "хорошо",
  "да",
  "нет",
]);

const LEADING_FILLER = /^(?:please|pls|plz|now|just|ok|okay|пожалуйста|просто|теперь)[,\s]+/;

type ProbeKind = "echo" | "tool_restriction" | "format" | "ping";

interface ProbeFragment {
  kind: ProbeKind;
  /** Raw payload for echo fragments (original casing). */
  payload?: string;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function wordTokens(text: string): string[] {
  return lower(text).match(/[\p{L}\p{N}_'’]+/gu)?.map((t) => t.replace(/’/g, "'")) ?? [];
}

function hasDurableMarker(text: string): boolean {
  const lowered = lower(text);
  for (const token of wordTokens(lowered)) {
    if (DURABLE_WORDS.has(token)) return true;
  }
  return DURABLE_PHRASES.some((re) => re.test(lowered));
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

function classifyFragment(original: string): ProbeFragment | null {
  let f = lower(original).replace(/’/g, "'").replace(/\s+/g, " ").trim();
  // Strip leading filler words, possibly several ("ok please just …").
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
  if (echo) {
    const payloadLower = stripQuotes(echo[1]!.replace(ECHO_PAYLOAD_TRAILER, ""));
    const payloadWords = payloadLower.split(/\s+/).filter((w) => w.length > 0);
    // A short literal payload ("LOCAL_OK", "pong", "yes or no") is an
    // echo probe. Any preposition ("only in Russian", "only tests for
    // new code") makes it a style or scope rule that may be meant to
    // last, so the fragment is not treated as a probe.
    if (
      payloadWords.length >= 1 &&
      payloadWords.length <= 3 &&
      !payloadWords.some((w) => STYLE_PREPOSITIONS.has(w))
    ) {
      // Recover the payload's original casing from the source fragment.
      const idx = lower(original).lastIndexOf(payloadLower);
      const payload =
        idx >= 0 ? original.slice(idx, idx + payloadLower.length) : payloadLower;
      return { kind: "echo", payload };
    }
  }
  return null;
}

/**
 * `true` when every user message in the window is made only of probe
 * fragments — echo commands ("reply exactly X"), one-off tool or
 * format restrictions ("do not use tools", "no explanation"), or
 * pings / greetings / acknowledgements — and nothing hints at a
 * lasting preference or a statement about the user. An empty window
 * is trivial too.
 *
 * Narrow by design: a single unrecognised clause ("what's the capital
 * of France?") makes the window non-trivial and reflection runs as
 * before.
 */
export function isTrivialReflectionWindow(userTexts: readonly string[]): boolean {
  for (const text of userTexts) {
    if (hasDurableMarker(text)) return false;
    for (const fragment of splitFragments(text)) {
      if (classifyFragment(fragment) === null) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Post-parse grounding filter
// ---------------------------------------------------------------------------

const NAME_KEY =
  /^(?:user_|my_)?(?:full_|first_|last_|given_|family_|preferred_|display_|real_|nick_?)?name$|^(?:nickname|username|user_name|alias|handle|user_handle|user_identity|identity)$/;

/**
 * Lead phrases after which a capitalised word is a claimed name for the
 * USER. Deliberately limited to first-person and "the user is …"
 * phrasings — generic "named X" / "name is X" (a file, a project) are
 * not identity claims and are left alone. Longer alternatives come
 * first so "user is named Sam" claims "Sam", not "named".
 */
const IDENTITY_LEAD =
  /(?:^|[^\p{L}])(i am|i'm|im|my name is|my name's|call me|remember me as|refer to me as|address me as|user is named|user is called|user is known as|user's name is|users name is|user name is|user is|меня зовут)\s+([^\s,.;:!?]+)(?:\s+([^\s,.;:!?]+))?/giu;

/** Capitalised words that follow "I am" without being a name. */
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
    String.raw`\byou are (?:my|a|an|the|our)\s+(?:personal\s+|ai\s+|helpful\s+|virtual\s+|local\s+)*(?:assistant|ai|agent|chatbot|bot)\b` +
      PERSONA_END,
    "i",
  ),
  new RegExp(
    String.raw`\bi am (?:an?\s+|the\s+|your\s+)?(?:personal\s+|ai\s+|helpful\s+|virtual\s+)*(?:ai|assistant|language model|llm|chatbot|memory extractor)\b` +
      PERSONA_END,
    "i",
  ),
  /\bmemory extractor\b/i,
  /\bas an ai\b/i,
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

/** Loose phonetic key so "Nadia" / "Nadya" / "Надя" compare equal-ish. */
function looseKey(word: string): string {
  return transliterate(lower(word))
    .replace(/[^a-z0-9]/g, "")
    .replace(/x/g, "ks")
    .replace(/j/g, "y")
    .replace(/w/g, "v")
    .replace(/ph/g, "f")
    .replace(/ia/g, "ya")
    .replace(/(.)\1+/g, "$1");
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

/** Letters outside Latin / Cyrillic — names there cannot be compared. */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Cyrillic}])\p{L}/u;

interface Vocabulary {
  keys: string[];
  /** When true, the identity check cannot verify and fails open. */
  unverifiable: boolean;
}

function buildVocabulary(ctx: GroundingContext): Vocabulary {
  const keys = new Set<string>();
  let unverifiable = false;
  const sources = [...ctx.userTexts, ...(ctx.knownNames ?? [])];
  for (const text of sources) {
    if (OTHER_SCRIPT.test(text)) unverifiable = true;
    for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
      const key = looseKey(token);
      if (key.length > 0) keys.add(key);
    }
  }
  return { keys: [...keys], unverifiable };
}

function isGrounded(word: string, vocab: Vocabulary): boolean {
  const key = looseKey(word);
  if (key.length === 0) return true;
  // One edit for short names, two for longer ones: enough for
  // romanisation drift (Nadia/Nadya, Aleksei/Alexey) without letting an
  // unrelated user word ("alerts") vouch for an invented "Alex".
  const tolerance = key.length <= 5 ? 1 : 2;
  for (const candidate of vocab.keys) {
    if (candidate === key) return true;
    if (candidate.length < 3 || key.length < 3) continue;
    if (candidate[0] !== key[0]) continue;
    if (Math.abs(candidate.length - key.length) > tolerance) continue;
    if (editDistance(candidate, key) <= tolerance) return true;
  }
  return false;
}

function startsUppercase(word: string): boolean {
  return /^\p{Lu}/u.test(word);
}

function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Names this text claims for the user ("I am Alex", "call me Sam"). */
function claimedNames(text: string): string[] {
  const out: string[] = [];
  IDENTITY_LEAD.lastIndex = 0;
  for (const match of text.matchAll(IDENTITY_LEAD)) {
    for (const raw of [match[2], match[3]]) {
      if (!raw) continue;
      const word = cleanWord(raw);
      if (word.length < 2) continue;
      if (!startsUppercase(word)) break;
      if (NON_NAME_CAPITALISED.has(lower(word))) break;
      out.push(word);
    }
  }
  return out;
}

function nameValueWords(value: string): string[] {
  return value
    .split(/[\s_]+/)
    .map(cleanWord)
    .filter((w) => w.length >= 2 && /\p{L}/u.test(w));
}

interface OneOffSignals {
  payloadTokens: string[];
  toolRestriction: boolean;
}

/**
 * Collect the one-off instructions seen in the window:
 *  - echo payload tokens worth matching ("LOCAL_OK"). Only distinctive
 *    tokens qualify — containing `_` / a digit, or all-caps and at
 *    least 4 letters — and only when the user never used the token
 *    outside the echo command itself. "Reply with only JSON. Our API
 *    uses JSON:API" keeps every note about JSON.
 *  - whether a one-off tool restriction ("do not use tools") appeared
 *    in a message that carries no durable marker ("remember",
 *    "always", …).
 */
function collectOneOffSignals(userTexts: readonly string[]): OneOffSignals {
  const payloadCounts = new Map<string, number>();
  let toolRestriction = false;
  for (const text of userTexts) {
    const durable = hasDurableMarker(text);
    for (const fragment of splitFragments(text)) {
      const probe = classifyFragment(fragment);
      if (!probe) continue;
      if (probe.kind === "tool_restriction" && !durable) toolRestriction = true;
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
  const tokens = lower(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
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
  // user literally wrote that phrase, which also keeps "I am an
  // assistant professor" safe when the user said so.
  for (const re of ASSISTANT_PERSONA) {
    const hit = re.exec(text);
    if (hit && !userTextLower.includes(lower(hit[0]))) return "assistant_persona";
  }
  if (!vocab.unverifiable) {
    for (const word of [...nameWords, ...claimedNames(text)]) {
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
    const nameWords = NAME_KEY.test(lower(fact.key)) ? nameValueWords(fact.value) : [];
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

/** `true` when a profile key names the user (`name`, `full_name`, …). */
export function isNameProfileKey(key: string): boolean {
  return NAME_KEY.test(lower(key));
}
