/**
 * Hard-coded allowlist of provider keys eligible for migration. Only
 * these two keys are ever read from Hermes' `.env` or written to the
 * atomic-agent `.env`. Both names are identical across the two projects,
 * so the migration is a verbatim copy.
 */
export const SECRET_ALLOWLIST = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
] as const;

export type SecretKey = (typeof SECRET_ALLOWLIST)[number];

export interface SelectedSecret {
  key: SecretKey;
  value: string;
}

/**
 * Filter a Hermes `.env` map down to the allowlisted provider keys with
 * non-empty values, in allowlist order. Pure — the value is carried in
 * the returned struct but callers must never log or print it (only the
 * `key` is safe for reports). Unknown keys and empty values are dropped.
 */
export function selectSecrets(
  envMap: ReadonlyMap<string, string>,
): SelectedSecret[] {
  const selected: SelectedSecret[] = [];
  for (const key of SECRET_ALLOWLIST) {
    const value = envMap.get(key);
    if (value !== undefined && value.length > 0) {
      selected.push({ key, value });
    }
  }
  return selected;
}
