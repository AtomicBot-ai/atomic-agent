/**
 * Per-session reversible map behind Privacy Shield (ATO-599).
 *
 * `mask` swaps every private value `findPrivateSpans` finds for a stable
 * placeholder, `[EMAIL_1]`, `[CARD_2]`, `[SECRET_1]`: the same value
 * always gets the same placeholder for the life of the vault, so a
 * request built from the same history masks to the same bytes (the
 * cloud's prompt cache keeps working) and the model can refer to "the
 * address in [EMAIL_1]" across turns. `unmask` puts the values back on
 * this machine, in the reply and in tool-call arguments, before anything
 * runs. The idea is Hermes' vault handle (the model holds an opaque
 * handle, the local side holds the value) applied to any text.
 *
 * The map lives in memory only and is never written anywhere: the
 * session history keeps the real text (it is local), and a new process
 * builds a new map from it.
 *
 * Once a value has been masked it is masked everywhere it appears later,
 * even in a context the detector would not recognise on its own (a key
 * first seen as `API_KEY=…`, later pasted bare).
 */

import type { KnownSecret } from "../error-reporting/secret-detector.js";
import { findPrivateSpans, PRIVATE_KINDS, type PrivateKind } from "./detect-private-data.js";

/** `[EMAIL_1]` and friends; anything else in square brackets is left alone. */
export const PLACEHOLDER = /\[(SECRET|IBAN|CARD|EMAIL|PHONE)_(\d{1,6})\]/g;

/** Shortest value the exact-match pass reapplies; shorter ones would shred ordinary words. */
const MIN_REAPPLY_LENGTH = 6;

/** Deepest nesting the deep walkers visit; anything below is left as is. */
const MAX_DEPTH = 32;

export interface PrivacyVaultStats {
  /** Distinct values this vault has masked so far. */
  distinct: number;
  /** The same, by kind. */
  byKind: Record<PrivateKind, number>;
  /** Distinct values in the most recent `beginRequest` … mask calls. */
  lastRequest: number;
  /** Requests that had at least one value masked. */
  maskedRequests: number;
}

export interface UnmaskOptions {
  /**
   * The text is the inside of a JSON string (tool-call arguments as they
   * stream): values are inserted JSON-escaped, so a quote or a backslash
   * in a real value cannot break the arguments.
   */
  json?: boolean;
}

export class PrivacyVault {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters: Record<PrivateKind, number> = {
    SECRET: 0,
    IBAN: 0,
    CARD: 0,
    EMAIL: 0,
    PHONE: 0,
  };
  /** Values reapplied by exact match, longest first; rebuilt lazily. */
  private reapply: string[] | null = null;
  private requestSeen: Set<string> | null = null;
  private lastRequest = 0;
  private maskedRequests = 0;

  /** `known` is read on every mask: the agent's own keys, which can change. */
  constructor(private readonly known: () => readonly KnownSecret[] = () => []) {}

  /** The placeholder for `value`, minted on first sight. */
  private placeholderFor(value: string, kind: PrivateKind): string {
    const existing = this.byValue.get(value);
    if (existing !== undefined) return existing;
    this.counters[kind] += 1;
    const placeholder = `[${kind}_${this.counters[kind]}]`;
    this.byValue.set(value, placeholder);
    this.byPlaceholder.set(placeholder, value);
    this.reapply = null;
    return placeholder;
  }

  private note(placeholder: string): void {
    this.requestSeen?.add(placeholder);
  }

  /**
   * Start counting one outgoing request: `stats().lastRequest` becomes
   * the number of distinct values masked between this call and the
   * next `endRequest`.
   */
  beginRequest(): void {
    this.requestSeen = new Set();
  }

  endRequest(): void {
    if (this.requestSeen === null) return;
    this.lastRequest = this.requestSeen.size;
    if (this.lastRequest > 0) this.maskedRequests += 1;
    this.requestSeen = null;
  }

  /** `text` with every private value replaced by its placeholder. */
  mask(text: string): string {
    if (text.length === 0) return text;
    const spans = findPrivateSpans(text, this.known());
    let out = text;
    if (spans.length > 0) {
      const parts: string[] = [];
      let last = 0;
      for (const span of spans) {
        parts.push(text.slice(last, span.start));
        const placeholder = this.placeholderFor(span.value, span.kind);
        this.note(placeholder);
        parts.push(placeholder);
        last = span.end;
      }
      parts.push(text.slice(last));
      out = parts.join("");
    }
    if (this.byValue.size === 0) return out;
    this.reapply ??= [...this.byValue.keys()]
      .filter((v) => v.length >= MIN_REAPPLY_LENGTH)
      .sort((a, b) => b.length - a.length);
    for (const value of this.reapply) {
      if (!out.includes(value)) continue;
      const placeholder = this.byValue.get(value)!;
      this.note(placeholder);
      out = out.split(value).join(placeholder);
    }
    return out;
  }

  /** `text` with every placeholder this vault minted put back. Unknown ones stay. */
  unmask(text: string, options: UnmaskOptions = {}): string {
    if (this.byPlaceholder.size === 0 || !text.includes("[")) return text;
    PLACEHOLDER.lastIndex = 0;
    return text.replace(PLACEHOLDER, (match) => {
      const value = this.byPlaceholder.get(match);
      if (value === undefined) return match;
      return options.json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  /** {@link mask} on every string inside plain objects and arrays. Keys are not masked. */
  maskDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.mask(s)) as T;
  }

  /** {@link unmask} on every string inside plain objects and arrays. */
  unmaskDeep<T>(value: T): T {
    if (this.byPlaceholder.size === 0) return value;
    return mapStrings(value, (s) => this.unmask(s)) as T;
  }

  /** Whether this vault has masked anything yet. */
  get isEmpty(): boolean {
    return this.byValue.size === 0;
  }

  stats(): PrivacyVaultStats {
    const byKind = Object.fromEntries(PRIVATE_KINDS.map((k) => [k, this.counters[k]])) as Record<
      PrivateKind,
      number
    >;
    return {
      distinct: this.byValue.size,
      byKind,
      lastRequest: this.lastRequest,
      maskedRequests: this.maskedRequests,
    };
  }
}

/**
 * `value` with `fn` applied to every string inside it. Plain objects and
 * arrays are copied only on the path to a changed string, so the input
 * is never mutated and an unchanged value comes back as itself.
 */
function mapStrings(value: unknown, fn: (s: string) => string, depth = 0): unknown {
  if (typeof value === "string") return fn(value);
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = mapStrings(value[i], fn, depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = mapStrings(child, fn, depth + 1);
    if (next !== child) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}
