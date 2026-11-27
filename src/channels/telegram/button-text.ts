/**
 * Fitting approval button text into Telegram's width (ATO-2757).
 *
 * The scope words are what a person decides on: "this session" or
 * "in this project". Cutting the end of `Allow browser commit on
 * very-long-host.example.com this session` drops exactly those words,
 * so a long label is shortened in the middle of the part that varies
 * (the host, path, origin or command) and keeps its opening verb and its
 * scope. Precedent: macOS Finder shortens a long file name in the middle
 * so both its start and its extension stay visible.
 *
 * The limit here is our own display budget for the button text in
 * characters: the Bot API sets no button text limit, but clients cut a
 * long one at the end. Telegram's real hard limit, 64 bytes, is on
 * `callback_data`, which these labels never touch.
 */

/** Longest approval button text, in characters. */
export const BUTTON_TEXT_MAX_CHARS = 60;

const ELLIPSIS = "…";

/** Opening verbs kept whole, longest first. */
const LEADS = ["Always allow ", "Allow all ", "Allow "];

/** Scope words kept whole at the end. */
const SCOPES = [" this session", " in this project"];

/**
 * `text` when it fits; else the same label with the middle of its
 * varying part replaced by "…". A label with no known verb or scope is
 * shortened in its middle as a whole, so its end still shows.
 */
export function fitButtonText(text: string, max = BUTTON_TEXT_MAX_CHARS): string {
  if (chars(text).length <= max) return text;
  const lead = LEADS.find((l) => text.startsWith(l)) ?? "";
  const scope = SCOPES.find((s) => text.endsWith(s) && text.length > lead.length + s.length) ?? "";
  const middle = text.slice(lead.length, text.length - scope.length);
  const budget = max - chars(lead).length - chars(scope).length;
  // A label whose fixed words alone nearly fill the button: shorten all of it.
  if (budget < 5) return shortenMiddle(text, max);
  return `${lead}${shortenMiddle(middle, budget)}${scope}`;
}

/**
 * `text` cut to `max` characters by dropping its middle. The end gets
 * the larger half: the file name of a path and the domain of a host.
 */
export function shortenMiddle(text: string, max: number): string {
  const all = chars(text);
  if (all.length <= max) return text;
  if (max <= 1) return ELLIPSIS;
  const keep = max - 1;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${all.slice(0, head).join("")}${ELLIPSIS}${all.slice(all.length - tail).join("")}`;
}

/** Code points, so an emoji or a non-Latin letter is never split in half. */
function chars(text: string): string[] {
  return Array.from(text);
}
