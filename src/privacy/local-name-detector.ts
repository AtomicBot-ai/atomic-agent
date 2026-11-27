/**
 * Names, street addresses and organisations for Privacy Shield, found by
 * a LOCAL model (ATO-2394). Regex cannot find a name; a small model on
 * this machine can, and the cloud then sees only `[NAME_1]`. The same
 * split as PAPILLON (arXiv 2410.17127) and the privacy mode of
 * HazyResearch Minions: the local model reads the private text, the
 * remote one gets the redacted version.
 *
 * Fail to the floor, always. The detector never throws and never sends
 * anything when it is unsure:
 *
 *  - no model, or a model whose `local` is not `true`: nothing is sent,
 *    nothing is found. Unmasked text never goes to a cloud model for
 *    detection, whatever the caller wires in.
 *  - an error, a timeout, a reply that is not the expected JSON: that
 *    piece adds nothing and is not cached, so the next request asks again.
 *  - a span the text does not contain word for word is dropped.
 *
 * What it returns only ever ADDS to the regex masks (`PrivacyVault.learn`
 * refuses anything that would change one).
 *
 * Cache: the spans of each paragraph, keyed by its SHA-256, in memory,
 * at most `cacheSize` paragraphs (oldest dropped first). A chat history
 * goes out again on every turn; only its new paragraphs reach the model.
 */

import { createHash } from "node:crypto";

import type { ModelFoundValue } from "./detect-private-data.js";
import {
  buildNameUserPrompt,
  NAME_DETECTOR_SYSTEM,
  NAME_SPANS_GRAMMAR,
  NAME_SPANS_SCHEMA,
  parseNameSpans,
} from "./local-name-prompt.js";

/** What the detector needs from a model: one constrained completion. */
export interface LocalNameModel {
  /** Provider id, for logs. */
  readonly id: string;
  /**
   * Whether the model runs on this machine or the local network. The
   * detector refuses any other value before a byte is sent.
   */
  readonly local: boolean;
  /** The raw reply text. May throw; the detector treats that as "nothing found". */
  complete(input: {
    system: string;
    user: string;
    grammar: string;
    schema: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface LocalNameDetectorOptions {
  /** Read on every `detect`: the local model now, or `null` when there is none (or the feature is off). */
  model: () => LocalNameModel | null;
  /** Budget for one whole `detect` call. Default 8 s. */
  timeoutMs?: number;
  /** Paragraphs remembered. Default 512. */
  cacheSize?: number;
  /** Characters of text per model call. Default 4000. */
  maxChunkChars?: number;
  /**
   * Model calls per `detect`. Paragraphs are queued newest message first,
   * so the latest text is the one read; what is left over goes out with
   * the regex masks only this time (logged through `onError`, without the
   * text) and is read on a later request. Default 4.
   */
  maxCallsPerDetect?: number;
  /** A failed call, for the log. Never rethrown. */
  onError?: (err: unknown, modelId: string) => void;
}

export interface LocalNameDetector {
  /**
   * The values found in the texts `readTexts` returns. `readTexts` is
   * called only when a local model is there to read them, so a caller
   * pays nothing to build them otherwise.
   */
  detect(readTexts: () => readonly string[], signal?: AbortSignal): Promise<ModelFoundValue[]>;
  /** Model calls made so far. */
  readonly calls: number;
}

/** Longest paragraph sent as one piece; longer ones are cut. */
const MAX_PARAGRAPH_CHARS = 2000;

/** The paragraphs of `text` worth a look: split on blank lines, with at least one letter. */
export function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n[ \t]*\n/)) {
    const paragraph = raw.trim();
    if (paragraph.length < 2 || !/\p{L}/u.test(paragraph)) continue;
    for (let i = 0; i < paragraph.length; i += MAX_PARAGRAPH_CHARS) {
      out.push(paragraph.slice(i, i + MAX_PARAGRAPH_CHARS));
    }
  }
  return out;
}

const hashOf = (paragraph: string): string => createHash("sha256").update(paragraph).digest("hex");

export function createLocalNameDetector(options: LocalNameDetectorOptions): LocalNameDetector {
  const timeoutMs = options.timeoutMs ?? 8000;
  const cacheSize = Math.max(1, options.cacheSize ?? 512);
  const maxChunkChars = options.maxChunkChars ?? 4000;
  const maxCalls = options.maxCallsPerDetect ?? 4;
  const cache = new Map<string, ModelFoundValue[]>();
  let calls = 0;

  const remember = (key: string, values: ModelFoundValue[]): void => {
    cache.delete(key);
    cache.set(key, values);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const recall = (key: string): ModelFoundValue[] | undefined => {
    const hit = cache.get(key);
    if (hit !== undefined) remember(key, hit);
    return hit;
  };

  async function detect(
    readTexts: () => readonly string[],
    signal?: AbortSignal,
  ): Promise<ModelFoundValue[]> {
    const model = options.model();
    // Refuse anything not local before reading a single text.
    if (model === null || model.local !== true) return [];
    const found = new Map<string, ModelFoundValue>();
    const add = (values: readonly ModelFoundValue[]): void => {
      for (const v of values) if (!found.has(v.value)) found.set(v.value, v);
    };
    const pending = new Map<string, string>();
    try {
      // Newest first: the latest message is what a capped or cut-short
      // pass must not skip. Its paragraphs newest first too.
      for (const text of [...readTexts()].reverse()) {
        for (const paragraph of splitParagraphs(text).reverse()) {
          const key = hashOf(paragraph);
          const hit = recall(key);
          if (hit !== undefined) add(hit);
          else pending.set(key, paragraph);
        }
      }
    } catch (err) {
      options.onError?.(err, model.id);
      return [];
    }
    if (pending.size === 0) return [...found.values()];

    const deadline = AbortSignal.timeout(timeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const chunks = chunksOf([...pending.entries()], maxChunkChars);
    let read = 0;
    for (const chunk of chunks.slice(0, maxCalls)) {
      if (callSignal.aborted) break;
      calls += 1;
      read += 1;
      let reply: string;
      try {
        // Raced against the signal: a model that ignores it still cannot
        // hold the cloud request past the budget.
        reply = await untilAborted(
          model.complete({
            system: NAME_DETECTOR_SYSTEM,
            user: buildNameUserPrompt(chunk.map(([, p]) => p).join("\n\n")),
            grammar: NAME_SPANS_GRAMMAR,
            schema: NAME_SPANS_SCHEMA,
            signal: callSignal,
          }),
          callSignal,
        );
      } catch (err) {
        options.onError?.(err, model.id);
        continue;
      }
      // A reply that came back after the deadline is not used.
      if (callSignal.aborted) break;
      const spans = parseNameSpans(reply);
      if (spans === null) {
        options.onError?.(new Error("local name detector: reply is not the expected JSON"), model.id);
        continue;
      }
      // An empty answer for several paragraphs at once may be one of them
      // talking the model out of answering: use it, but do not keep it.
      const keep = spans.length > 0 || chunk.length === 1;
      for (const [key, paragraph] of chunk) {
        // Only a span this paragraph contains word for word counts.
        const values = spans
          .filter((s) => paragraph.includes(s.text))
          .map((s) => ({ value: s.text, kind: s.kind }));
        if (keep) remember(key, values);
        add(values);
      }
    }
    const left = chunks.slice(read).reduce((n, chunk) => n + chunk.length, 0);
    if (left > 0) {
      options.onError?.(
        new Error(`local name detector: ${left} older paragraph(s) left for a later request, regex masks only`),
        model.id,
      );
    }
    return [...found.values()];
  }

  return {
    detect,
    get calls() {
      return calls;
    },
  };
}

/** `work`, or a rejection as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Paragraphs grouped into calls of at most `maxChars` (one long paragraph is a call of its own). */
function chunksOf(entries: [string, string][], maxChars: number): [string, string][][] {
  const chunks: [string, string][][] = [];
  let current: [string, string][] = [];
  let size = 0;
  for (const entry of entries) {
    const length = entry[1].length + 2;
    if (current.length > 0 && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
