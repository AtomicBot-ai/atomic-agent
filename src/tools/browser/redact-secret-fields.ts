/**
 * Playwright's ARIA snapshot prints an input's live value after its
 * line (`- textbox "Password" [ref=e5]: hunter2`), password fields
 * included. Before the snapshot reaches the model, the values of secret
 * fields (password, one-time code, card number / CVC / expiry) are
 * replaced with a mask. Matters most in the user's own Chrome, where a
 * saved password can sit filled in on a sign-in page.
 */
export const SECRET_MASK = "••••";

/** Values this long are masked wherever they appear, not just at a line end. */
const GLOBAL_MATCH_MIN = 6;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not a JSON string; compare as written
    }
  }
  return value;
}

export function redactSecretFieldValues(text: string, secrets: readonly string[]): string {
  const values = new Set(secrets.filter((s) => s.length > 0));
  if (values.size === 0) return text;
  const lines = text.split("\n").map((line) => {
    // The value follows the element's last `[…]` attribute (`[ref=e2]: v`);
    // a line without one is plain `role "name": v`.
    const bracket = line.indexOf("]: ");
    const at = bracket >= 0 ? bracket + 1 : line.lastIndexOf(": ");
    if (at < 0) return line;
    const tail = line.slice(at + 2);
    return values.has(tail) || values.has(unquote(tail))
      ? `${line.slice(0, at + 2)}${SECRET_MASK}`
      : line;
  });
  let out = lines.join("\n");
  for (const value of values) {
    if (value.length >= GLOBAL_MATCH_MIN) out = out.split(value).join(SECRET_MASK);
  }
  return out;
}

const SECRET_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
];

/**
 * Runs in the page (`frame.evaluate`): the non-empty values of secret
 * fields in this frame. Values stay inside the backend; they are only
 * used to mask the snapshot text.
 */
export function collectSecretFieldValuesInPage(autocompleteTokens: string[]): string[] {
  const doc = (globalThis as unknown as {
    document: { querySelectorAll: (s: string) => ArrayLike<{ type?: string; value?: string; getAttribute: (n: string) => string | null }> };
  }).document;
  const out: string[] = [];
  const inputs = doc.querySelectorAll("input, textarea");
  for (let i = 0; i < inputs.length; i += 1) {
    const el = inputs[i]!;
    const type = (el.type ?? "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    const secret = type === "password" || auto.some((t) => autocompleteTokens.includes(t));
    if (secret && typeof el.value === "string" && el.value.length > 0) out.push(el.value);
  }
  return out;
}

export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = SECRET_AUTOCOMPLETE;
