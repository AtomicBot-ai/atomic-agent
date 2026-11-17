import { maskSecrets } from "../../error-reporting/secret-detector.js";
import { normaliseProfileValue } from "../profile-duplicates.js";
import { REFLECTION_GRAMMAR } from "../reflection/reflection-grammar.js";
import { filterUngroundedReflection } from "../reflection/reflection-grounding.js";
import { parseReflectionOutput } from "../reflection/reflection-parser.js";

import {
  assertImportFactsEngineAllowed,
  type ImportFactsEngine,
} from "./import-facts-engine.js";
import { buildImportFactsPrompt } from "./import-facts-prompt.js";

/**
 * ATO-1623. Run chunks of the person's old messages through a model and
 * return candidate facts with the message that backs each one. Nothing
 * is written to memory here: the person ticks what to keep first
 * (ATO-1627 terminal, ATO-1629 desktop) and
 * src/import/user-facts/save-fact-candidates.ts
 * writes only those.
 *
 * - The engine check runs before the first chunk is sent
 *   (import-facts-engine.ts): a cloud model without consent sends nothing.
 * - Every candidate must be grounded in the chunk's own messages (the
 *   reflection grounding filter) and must not look like a secret, a card
 *   number, an e-mail or a phone number.
 * - `signal` stops between chunks; what was found so far is returned
 *   with `stopped: true`.
 * - No message text is logged: `onProgress` gets numbers only.
 */

/** Structural twin of `UserMessageChunk` (src/import/user-facts), so memory does not import from import. */
export interface FactChunk {
  index: number;
  messages: readonly { chatId: string; text: string }[];
}

export type FactCandidateKind = "profile" | "note";

export interface FactCandidate {
  /** Stable within one run: `c<chunk>-<n>`. The UI sends back the ids the person ticked. */
  id: string;
  kind: FactCandidateKind;
  /** Profile key; `null` for a note. */
  key: string | null;
  /** Profile value or note body. */
  value: string;
  /** Profile facts: always shown in the profile (true) or only on topic. */
  pinned: boolean;
  /** Chat the backing message came from. */
  chatId: string;
  /** The person's message the fact rests on, cut to {@link FACT_QUOTE_MAX_CHARS}. */
  quote: string;
}

export const FACT_QUOTE_MAX_CHARS = 200;

/** One model call: prompt in, raw completion out. The caller binds the actual client. */
export type ImportFactsComplete = (
  prompt: string,
  options: { grammar: string; signal: AbortSignal },
) => Promise<string>;

export interface ImportFactsProgress {
  chunksDone: number;
  chunksTotal: number;
  candidates: number;
}

export interface ExtractFactCandidatesInput {
  chunks: readonly FactChunk[];
  engine: ImportFactsEngine;
  complete: ImportFactsComplete;
  signal?: AbortSignal;
  knownProfile?: readonly { key: string; value: string }[];
  onProgress?: (progress: ImportFactsProgress) => void;
}

export interface ExtractFactCandidatesResult {
  candidates: FactCandidate[];
  chunksDone: number;
  chunksTotal: number;
  /** Stopped by `signal` before the last chunk. */
  stopped: boolean;
  /** Chunks whose model call failed; the run goes on without them. */
  failedChunks: number;
  /** Counts of what was thrown away, by reason. Numbers only. */
  dropped: { ungrounded: number; sensitive: number; duplicate: number };
}

export async function extractFactCandidates(
  input: ExtractFactCandidatesInput,
): Promise<ExtractFactCandidatesResult> {
  assertImportFactsEngineAllowed(input.engine);
  const signal = input.signal ?? new AbortController().signal;
  const chunksTotal = input.chunks.length;
  const candidates: FactCandidate[] = [];
  const seen = new Set<string>();
  const dropped = { ungrounded: 0, sensitive: 0, duplicate: 0 };
  let chunksDone = 0;
  let failedChunks = 0;
  let stopped = false;

  for (const chunk of input.chunks) {
    if (signal.aborted) {
      stopped = true;
      break;
    }
    const texts = chunk.messages.map((m) => m.text);
    let raw: string;
    try {
      raw = await input.complete(
        buildImportFactsPrompt({ messages: texts, knownProfile: input.knownProfile }),
        { grammar: REFLECTION_GRAMMAR, signal },
      );
    } catch {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      failedChunks += 1;
      chunksDone += 1;
      input.onProgress?.({ chunksDone, chunksTotal, candidates: candidates.length });
      continue;
    }
    const parsed = parseReflectionOutput(raw);
    const grounded = filterUngroundedReflection(
      { facts: parsed.facts, notes: parsed.notes },
      { userTexts: texts },
    );
    dropped.ungrounded += grounded.dropped.length;

    let n = 0;
    const push = (c: Omit<FactCandidate, "id" | "chatId" | "quote">): void => {
      if (isSensitive(c.key, c.value)) {
        dropped.sensitive += 1;
        return;
      }
      const dedupKey = `${c.kind}|${c.key ?? ""}|${normaliseProfileValue(c.value)}`;
      if (seen.has(dedupKey)) {
        dropped.duplicate += 1;
        return;
      }
      seen.add(dedupKey);
      const backing = bestBackingMessage(chunk.messages, `${c.key ?? ""} ${c.value}`);
      candidates.push({
        ...c,
        id: `c${chunk.index}-${n++}`,
        chatId: backing.chatId,
        quote: quoteOf(backing.text),
      });
    };
    for (const f of grounded.facts) {
      push({ kind: "profile", key: f.key, value: f.value.trim(), pinned: f.pinned });
    }
    for (const note of grounded.notes) {
      push({ kind: "note", key: null, value: note.body.trim(), pinned: false });
    }
    chunksDone += 1;
    input.onProgress?.({ chunksDone, chunksTotal, candidates: candidates.length });
  }

  return { candidates, chunksDone, chunksTotal, stopped, failedChunks, dropped };
}

/** Key words that name a secret or a contact detail; such a fact is never offered. */
const SENSITIVE_KEY_PARTS: ReadonlySet<string> = new Set([
  "password", "passwd", "passcode", "passphrase", "pwd", "secret", "token",
  "apikey", "credential", "credentials", "pin", "cvv", "cvc", "iban", "ssn",
  "passport", "email", "phone", "mobile", "address", "login",
]);
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** A run of digits and separators. */
const NUMBER_RUN = /\+?\d[\d\s().-]*\d/g;
/** 9+ digits in one run: a phone, account or document number (a year range has 8). */
const LONG_NUMBER_DIGITS = 9;

export function isSensitive(key: string | null, value: string): boolean {
  if (key) {
    const parts = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.some((p) => SENSITIVE_KEY_PARTS.has(p))) return true;
    if (parts.includes("api") && parts.includes("key")) return true;
    if (parts.includes("card") && (parts.includes("number") || parts.includes("no"))) return true;
  }
  if (maskSecrets(value) !== value || value.includes("[redacted:")) return true;
  if (EMAIL.test(value)) return true;
  for (const run of value.match(NUMBER_RUN) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (luhn(digits) || digits.length >= LONG_NUMBER_DIGITS) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The message sharing the most words with the fact; the first one on a tie. */
function bestBackingMessage(
  messages: readonly { chatId: string; text: string }[],
  factText: string,
): { chatId: string; text: string } {
  const want = words(factText);
  let best = messages[0] ?? { chatId: "", text: "" };
  let bestScore = -1;
  for (const m of messages) {
    const have = words(m.text);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

function quoteOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > FACT_QUOTE_MAX_CHARS ? `${flat.slice(0, FACT_QUOTE_MAX_CHARS - 1)}…` : flat;
}
