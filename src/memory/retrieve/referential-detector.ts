/**
 * v2.5 heuristic gate for the query rewriter (Phase A).
 *
 * The detector is the cheap filter that decides whether to spend an
 * LLM call rewriting the current user message into a self-contained
 * query. Goal: skip the rewriter on long / self-contained / first-turn
 * messages and only fire on the short referential follow-ups where
 * BM25/cosine recall on the raw message would yield zero useful hits.
 *
 * Pure function — no I/O, no state. Easy to test with a matrix of
 * `(message, historyLength)` pairs.
 *
 * Gate fires (returns `true`) when **any** of:
 *  1. Message has at least one prior exchange of history (recent
 *     turns non-empty), AND
 *  2. Message length ≤ {@link SHORT_MESSAGE_WORD_THRESHOLD} words and
 *     does not contain a question word, OR
 *  3. Message contains a pronoun from the allowlist, OR
 *  4. Message begins with a conjunction starter from the allowlist.
 *
 * **Language coverage (16 languages, whitespace tokenization):**
 * en, ru, es, de, fr, pt, it, nl, pl, tr, ar, he, hi, vi, id, ko.
 *
 * **Deferred:** CJK (zh, ja) and Thai — no inter-word spaces, so
 * `split(/\s+/)` returns one token for the whole utterance. Use
 * `memory.retrieve.rewriter.gateMode = "embedding"` for those scripts
 * (`Intl.Segmenter` heuristic support is a follow-up).
 */
export function isReferentialMessage(
  message: string,
  historyTurnCount: number,
): boolean {
  if (historyTurnCount <= 0) return false;
  const normalised = message.trim().toLowerCase();
  if (normalised.length === 0) return false;

  const words = normalised.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;

  if (wordCount <= SHORT_MESSAGE_WORD_THRESHOLD && !hasQuestionWord(words)) {
    return true;
  }
  if (hasPronoun(words)) return true;
  if (hasConjunctionStarter(words[0] ?? "")) return true;
  return false;
}

/**
 * Short-message floor for the gate. Heuristic floor tuned for short follow-ups — matches
 * `pre_retrieval_decision` rule of thumb that messages with ≤ 5
 * meaningful words are usually anaphoric continuations of a prior
 * turn. Exposed so tests can pin the threshold.
 */
export const SHORT_MESSAGE_WORD_THRESHOLD = 5;

const PRONOUN_ALLOWLIST: ReadonlySet<string> = new Set([
  // en
  "it",
  "that",
  "they",
  "them",
  "those",
  "this",
  "these",
  "same",
  "more",
  // ru
  "он",
  "она",
  "оно",
  "они",
  "это",
  "то",
  "такой",
  "такая",
  "такие",
  "ещё",
  // es
  "eso",
  "esto",
  "ese",
  "esa",
  "él",
  "ella",
  "ellos",
  "más",
  // de
  "das",
  "es",
  "sie",
  "er",
  "die",
  "jene",
  "mehr",
  // fr
  "ça",
  "cela",
  "il",
  "elle",
  "ils",
  "celui",
  "plus",
  // pt
  "isso",
  "esse",
  "ele",
  "ela",
  "eles",
  "mais",
  // it
  "ciò",
  "esso",
  "lui",
  "lei",
  "loro",
  "più",
  // nl
  "dat",
  "het",
  "hij",
  "zij",
  "ze",
  "deze",
  "meer",
  // pl (omit bare "to" — collides with English preposition "to")
  "tamto",
  "tego",
  "temu",
  "on",
  "ona",
  "oni",
  "więcej",
  // tr
  "bu",
  "şu",
  "o",
  "onlar",
  "daha",
  // ar
  "ذلك",
  "هذا",
  "هو",
  "هي",
  "هم",
  "أكثر",
  // he
  "זה",
  "זו",
  "הוא",
  "היא",
  "הם",
  "יותר",
  // hi
  "यह",
  "वह",
  "उसे",
  "उन्हें",
  // vi
  "đó",
  "này",
  "anh",
  "cô",
  "họ",
  "hơn",
  // id
  "itu",
  "ini",
  "dia",
  "mereka",
  "lagi",
  // ko
  "그",
  "저",
  "이",
  "더",
]);

const CONJUNCTION_STARTERS: ReadonlySet<string> = new Set([
  // en
  "and",
  "but",
  "also",
  // ru
  "а",
  "и",
  "но",
  "ещё",
  "или",
  // es
  "y",
  "pero",
  "también",
  // de
  "und",
  "aber",
  "auch",
  // fr
  "et",
  "mais",
  "aussi",
  // pt
  "e",
  "mas",
  "também",
  // it
  "ma",
  "anche",
  // nl
  "en",
  "maar",
  "ook",
  // pl
  "ale",
  "też",
  // tr
  "ve",
  "ama",
  "da",
  // ar
  "و",
  "لكن",
  "أيضا",
  // he
  "ו",
  "אבל",
  "גם",
  // hi
  "और",
  "लेकिन",
  "भी",
  // vi
  "và",
  "nhưng",
  "cũng",
  // id
  "dan",
  "tapi",
  "juga",
  // ko
  "그리고",
  "하지만",
  "또",
]);

const QUESTION_WORDS: ReadonlySet<string> = new Set([
  // en
  "what",
  "when",
  "where",
  "why",
  "how",
  "who",
  "which",
  // ru
  "что",
  "когда",
  "где",
  "почему",
  "зачем",
  "как",
  "кто",
  "какой",
  "какая",
  "какие",
  // es
  "qué",
  "dónde",
  "cuándo",
  "cómo",
  "quién",
  "cuál",
  "por",
  // de
  "was",
  "wo",
  "wann",
  "wie",
  "warum",
  "wer",
  "welche",
  // fr
  "que",
  "où",
  "quand",
  "comment",
  "pourquoi",
  "qui",
  "quel",
  // pt
  "onde",
  "porquê",
  "quem",
  "qual",
  // it
  "che",
  "dove",
  "quando",
  "come",
  "perché",
  "chi",
  "quale",
  // nl
  "wat",
  "waar",
  "wanneer",
  "hoe",
  "waarom",
  "wie",
  "welk",
  // pl
  "co",
  "gdzie",
  "kiedy",
  "jak",
  "dlaczego",
  "kto",
  "który",
  // tr
  "ne",
  "nerede",
  "nasıl",
  "neden",
  "kim",
  "hangi",
  // ar
  "ما",
  "ماذا",
  "أين",
  "متى",
  "كيف",
  "لماذا",
  "من",
  "أي",
  // he
  "מה",
  "איפה",
  "מתי",
  "איך",
  "למה",
  "מי",
  "איזה",
  // hi
  "क्या",
  "कहाँ",
  "कब",
  "कैसे",
  "क्यों",
  "कौन",
  "कौनसा",
  // vi
  "gì",
  "đâu",
  "sao",
  "tại",
  "ai",
  "nào",
  // id
  "apa",
  "di",
  "kapan",
  "bagaimana",
  "mengapa",
  "siapa",
  "yang",
  // ko
  "뭐",
  "어디",
  "언제",
  "어떻게",
  "왜",
  "누가",
  "어느",
]);

function hasQuestionWord(words: readonly string[]): boolean {
  for (const word of words) {
    if (QUESTION_WORDS.has(stripPunctuation(word))) return true;
  }
  return false;
}

function hasPronoun(words: readonly string[]): boolean {
  for (const word of words) {
    if (PRONOUN_ALLOWLIST.has(stripPunctuation(word))) return true;
  }
  return false;
}

function hasConjunctionStarter(first: string): boolean {
  return CONJUNCTION_STARTERS.has(stripPunctuation(first));
}

function stripPunctuation(word: string): string {
  return word.replace(/^[.,!?;:"'`(]+|[.,!?;:"'`)]+$/g, "");
}
