/* ATO-2530: where a saved key really comes from, for the "from 1Password"
   label in Settings › Models. Mirrors src/config/saved-secret-refs.ts
   secretRefSource: the scheme of a reference (op://, bw://, vault://,
   cmd://, ATO-2339) is all that is read; never a value, and only the
   label crosses to the renderer. A key the agent keeps in the OS keychain
   is "keychain" (its value is not read here). A plain .env key gets no
   label: that is where keys live by default. */

export type SecretSourceLabel = "1password" | "bitwarden" | "vault" | "command" | "keychain";

/** The source a saved value names, or null for a plain key. */
export function secretRefSourceOf(value: string): Exclude<SecretSourceLabel, "keychain"> | null {
  const raw = value.trim();
  if (raw.startsWith("op://")) return "1password";
  if (raw.startsWith("bw://")) return "bitwarden";
  if (raw.startsWith("vault://")) return "vault";
  if (raw.startsWith("cmd://")) return "command";
  return null;
}

/** A `.env` value as load-dotenv.ts reads it: trimmed, one pair of matching quotes removed. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

/**
 * name -> label for `.env` text plus the names held in the keychain.
 * A `.env` line wins over the keychain for the same name, as at load.
 */
export function secretSources(dotenvText: string, keychainNames: readonly string[]): Record<string, SecretSourceLabel> {
  const out: Record<string, SecretSourceLabel> = {};
  const inFile = new Set<string>();
  for (const line of dotenvText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    const value = unquote(trimmed.slice(eq + 1));
    if (value.length === 0) continue;
    inFile.add(key);
    const source = secretRefSourceOf(value);
    if (source !== null) out[key] = source;
    else delete out[key];
  }
  for (const name of keychainNames) if (!inFile.has(name)) out[name] = "keychain";
  return out;
}
