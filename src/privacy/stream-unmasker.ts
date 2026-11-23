/**
 * Puts placeholders back in a reply that arrives in pieces (ATO-599 /
 * ATO-1081). A stream can cut a placeholder anywhere, `[EMA` in one
 * chunk and `IL_1]` in the next, so a tail that could still grow into a
 * placeholder is held back until the next chunk decides it (or `flush`
 * at the end of the stream). Everything else is released at once, so the
 * text shown while streaming lags by at most one partial placeholder.
 */

import type { PrivacyVault, UnmaskOptions } from "./privacy-vault.js";

const KINDS = ["SECRET", "CARD", "IBAN", "EMAIL", "PHONE"] as const;

/** Longest placeholder: `[SECRET_999999]`. */
const MAX_PLACEHOLDER = 15;

/**
 * Where a still-open placeholder starts at the end of `text`, or
 * `text.length` when the tail cannot be the start of one.
 */
export function partialPlaceholderStart(text: string): number {
  const open = text.lastIndexOf("[");
  if (open < 0 || text.length - open >= MAX_PLACEHOLDER) return text.length;
  const tail = text.slice(open + 1);
  if (/^[A-Z]*$/.test(tail)) {
    return KINDS.some((k) => k.startsWith(tail)) ? open : text.length;
  }
  const m = /^([A-Z]+)_\d{0,6}$/.exec(tail);
  if (m && (KINDS as readonly string[]).includes(m[1]!)) return open;
  return text.length;
}

export interface StreamUnmasker {
  /** Unmasked text that is safe to show now. */
  push(delta: string): string;
  /** Whatever was held back, unmasked. Call once at the end. */
  flush(): string;
}

export function createStreamUnmasker(vault: PrivacyVault, options: UnmaskOptions = {}): StreamUnmasker {
  let pending = "";
  return {
    push(delta) {
      if (delta.length === 0) return "";
      const text = pending + delta;
      const cut = partialPlaceholderStart(text);
      pending = text.slice(cut);
      return vault.unmask(text.slice(0, cut), options);
    },
    flush() {
      const out = vault.unmask(pending, options);
      pending = "";
      return out;
    },
  };
}
