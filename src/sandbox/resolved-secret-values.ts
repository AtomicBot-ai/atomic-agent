/**
 * Secret values resolved from references in this process (ATO-476,
 * ATO-2339): a `.env` value written as `op://…`, `bw://…` or `cmd://…`
 * and the tool secrets a shell command names as `{{secret:NAME}}`.
 *
 * They live only here, in process memory: never written back to `.env`,
 * the keychain or `config.json`. Every value held here is masked in tool
 * output, errors and traces (as exact text, plus its common encodings),
 * because the secret detector's exact-value
 * layer (`src/error-reporting/secret-detector.ts`) reads this list on
 * every call, whatever list of known secrets its caller passed.
 *
 * A leaf module on purpose: the detector, the resolver and the output
 * capture all import it, so it imports nothing.
 */

export interface ResolvedSecretValue {
  /** The variable or tool-secret name; shown in the redaction marker. */
  label: string;
  value: string;
}

/** value -> label. Keyed by value, so a rotated secret keeps its old value masked too. */
const values = new Map<string, string>();

/**
 * The common encodings a command prints a secret in without meaning to
 * transform it: base64 (with and without padding, and of the value with
 * the trailing newline `echo` adds), base64url, URL-encoding. Masking is
 * by exact text, so each is registered as its own value. A deliberate
 * transform (`rev`, a cipher, one character per line) is not covered;
 * the person approving the command sees it written there.
 */
export function encodedSecretVariants(value: string): string[] {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const out = [
    b64,
    b64.replace(/=+$/, ""),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(`${value}\n`, "utf8").toString("base64"),
    encodeURIComponent(value),
  ];
  return [...new Set(out)].filter((v) => v !== value && v.length > 0);
}

/**
 * Remember `value` under `label`, with its {@link encodedSecretVariants}.
 * An empty value is ignored.
 */
export function rememberResolvedSecret(label: string, value: string): void {
  if (value.length === 0) return;
  values.set(value, label);
  for (const variant of encodedSecretVariants(value)) {
    if (!values.has(variant)) values.set(variant, label);
  }
}

/** Every value resolved in this process, old ones included. */
export function resolvedSecretValues(): ResolvedSecretValue[] {
  return [...values].map(([value, label]) => ({ label, value }));
}

/** Test seam: forget every value. */
export function resetResolvedSecretValues(): void {
  values.clear();
}
