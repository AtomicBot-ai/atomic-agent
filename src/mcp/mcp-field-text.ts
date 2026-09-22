/**
 * Rendering helpers for one field of an MCP catalog row.
 *
 * An MCP server is untrusted input: `mcp-client.ts` copies every
 * catalog field into the catalog verbatim, with no clamp and no
 * sanitising of any kind. The listing tools render those fields one
 * row per line, so a field is allowed to break neither the line
 * format nor the terminal — and, when the model has to hand the
 * value back, neither may it be altered.
 *
 * Hence two functions, and the difference between them is the whole
 * point:
 *
 *   - `flattenKey` is for values the model must echo back exactly —
 *     a resource `uri`, a prompt `name`, an argument name. They are
 *     made line-safe and otherwise left ALONE. Shortening one would
 *     hand the model a key that looks real and cannot work.
 *   - `clampField` is for display-only text — a name, a description,
 *     a mime type. Nothing passes these back, so they can be cut.
 *
 * `os.email.inbox` (`tools/os/email.ts`) clamps its fields the same
 * way, but every field it clamps is display-only; it has no keys, so
 * it needs no equivalent of `flattenKey`.
 */

/**
 * Characters that break a one-row-per-line listing or the terminal
 * drawing it: C0/C1 controls (newline and tab among them), the
 * Unicode line/paragraph separators, and the bidi overrides and
 * isolates — U+202E reverses the rest of the rendered line, which is
 * how a hostile row disguises itself as a different one.
 */
const LINE_BREAKING =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * Additionally stripped from display-only text: zero-width and
 * invisible formatting characters. Deliberately NOT applied to keys
 * — they do not break a line, and removing one would corrupt a value
 * the model has to send back.
 */
const INVISIBLE = /[\u200b-\u200f\u2060-\u2064\ufeff]+/g;

/**
 * A value the model may have to pass back, made safe to put on a
 * line and otherwise untouched. Never shortened.
 */
export function flattenKey(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(LINE_BREAKING, " ").trim();
}

/**
 * Display-only text: flattened, stripped of invisibles, collapsed to
 * one line and cut to `max`.
 *
 * The cut is by UTF-16 code unit, so it can land between the two
 * halves of a surrogate pair — an emoji at the boundary would leave
 * a lone high surrogate that becomes U+FFFD once the prompt is
 * encoded as UTF-8. The trailing-surrogate strip drops that half
 * character rather than emit a replacement glyph. (`email.ts` has
 * the same cut and the same gap; fixing it there is out of scope
 * here.)
 */
export function clampField(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return text
    .replace(LINE_BREAKING, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "");
}
