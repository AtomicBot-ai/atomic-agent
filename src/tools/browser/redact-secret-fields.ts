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
 * A one-time code field that does not say so with
 * `autocomplete="one-time-code"` (ATO-1260: an 8-digit sign-in code went
 * into a field named only "Verification code"), read from its name, id,
 * placeholder and label text, lowercased. A bare "code" counts unless a
 * word before it makes it a postal, promo or similar code.
 */
export const ONE_TIME_CODE_HINT =
  "one.?time|\\botp\\b|\\btotp\\b|\\b2fa\\b|\\bmfa\\b|two.?(factor|step)|passcode|\\bpin\\b|" +
  "(verif\\w*|confirm\\w*|auth\\w*|security|access|login|sign.?in|sms|text|email|e-mail|backup|recovery|6.?digit|8.?digit)[\\s_-]*code|" +
  "(?<![\\p{L}\\p{N}_-])(?<!(zip|postal|post|promo|coupon|discount|gift|voucher|area|country|referral|invite|invitation|source|tracking|product|qr|bar|color|colour|currency|language|region|tax|sort|swift|bank|routing|reference)[\\s_-]*)code(?![\\p{L}\\p{N}])|" +
  "(?<![\\p{L}\\p{N}])(?<!(почтов\\p{L}*|промо)[\\s_-]*)(код|kod)(?![\\p{L}]*[\\s_-]*(товар|купон|промо|город|стран|регион|почт))";

const ONE_TIME_CODE_FIELD = new RegExp(ONE_TIME_CODE_HINT, "iu");

/** `fieldHints` (lowercased name / id / placeholder / labels) name a one-time code. */
export function isOneTimeCodeHint(fieldHints: string): boolean {
  return ONE_TIME_CODE_FIELD.test(fieldHints);
}

/**
 * Runs in the page (`frame.evaluate`): the non-empty values of secret
 * fields in this frame (by type, autocomplete, or a one-time code's
 * name/label, `codeHint` being {@link ONE_TIME_CODE_HINT}). Values stay
 * inside the backend; they are only used to mask the snapshot text.
 */
export function collectSecretFieldValuesInPage(arg: {
  tokens: string[];
  codeHint: string;
}): string[] {
  type Field = {
    type?: string;
    value?: string;
    labels?: ArrayLike<{ textContent: string | null }> | null;
    getAttribute: (n: string) => string | null;
  };
  const doc = (globalThis as unknown as {
    document: { querySelectorAll: (s: string) => ArrayLike<Field> };
  }).document;
  const codeField = new RegExp(arg.codeHint, "iu");
  const out: string[] = [];
  const inputs = doc.querySelectorAll("input, textarea");
  for (let i = 0; i < inputs.length; i += 1) {
    const el = inputs[i]!;
    if (typeof el.value !== "string" || el.value.length === 0) continue;
    const type = (el.type ?? "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    let secret = type === "password" || auto.some((t) => arg.tokens.includes(t));
    if (!secret) {
      const labels = el.labels ? Array.from(el.labels, (l) => l.textContent ?? "") : [];
      const hints = [
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        ...labels,
      ].filter(Boolean).join(" ").toLowerCase();
      secret = codeField.test(hints);
    }
    if (secret) out.push(el.value);
  }
  return out;
}

export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = SECRET_AUTOCOMPLETE;
