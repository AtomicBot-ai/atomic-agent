import { randomInt } from "node:crypto";

/**
 * ATO-2494: the short code that pairs a browser by typing instead of
 * scanning. An iPhone home-screen app keeps its own cookies, apart from
 * Safari, so a phone paired in Safari opens the home-screen app signed
 * out; there is no camera there to scan the QR again, so the app asks
 * for this code (`/panel/pair`), shown next to the QR on the computer.
 *
 * The shape follows the OAuth device flow (RFC 8628 section 6.1, the
 * code a TV shows for YouTube or Netflix): 8 letters from 20 consonants
 * (no vowels, so no words; no 0/O or 1/I), shown as `BCDF-GHJK`. That is
 * about 34 bits. It lives as long as the QR link (5 minutes), only its
 * hash is stored (unsalted, so the owner-only file is what protects it
 * during those 5 minutes, not the hash), and `DeviceSessions` stops taking codes after
 * `MAX_CODE_FAILURES` wrong ones until a new code is made.
 */
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const CODE_LENGTH = 8;

/** Wrong codes, from every address together, before codes stop working until a new one is made. */
export const MAX_CODE_FAILURES = 20;

/** Of those, how many one caller address may spend, so one neighbour cannot lock everyone out. */
export const MAX_CODE_FAILURES_PER_ADDRESS = 5;

/** A new code, without the dash: `BCDFGHJK`. */
export function newPairingCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** `BCDFGHJK` as people read it: `BCDF-GHJK`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a person typed, as the stored form: case, spaces and dashes do
 * not matter. `null` when it cannot be a code (wrong length or a letter
 * outside the alphabet), so it is refused before the store is touched.
 */
export function normalizePairingCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}
