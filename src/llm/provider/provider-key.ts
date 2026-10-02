import type { UserSubscriptionCliOptions } from "../../config/llm-config.js";
import { usesExternalCliAuth } from "../../config/provider-auth-mode.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { isLocalProviderUrl } from "./presets/is-local-provider-url.js";
import { presetForEntryId } from "./presets/provider-presets.js";

/**
 * The one answer to "does this provider have the key it needs?".
 *
 * Three places asked it with three different rules, and they disagreed
 * about the same entry: `/model` in a chat channel (refuse a switch to a
 * provider that cannot authenticate), the fallback chain (skip a link that
 * cannot authenticate instead of trying it) and the TUI's first-run check
 * (is a cloud provider ready to serve). LM Studio saved from the wizard
 * carries `apiKeyEnvVar: "LMSTUDIO_API_KEY"`, so `/model lmstudio` was
 * refused for a missing key the fallback chain and the TUI both knew it
 * did not need. They all read this now.
 *
 * The rule, in order:
 *  1. `present`: a key resolves, or a header named like a credential is
 *     set by hand (`Authorization`, `x-api-key`, the entry's own
 *     `apiKeyHeader`).
 *  2. `not-needed`: the entry signs in through a vendor CLI, or it is a
 *     local server: made from a `local` preset (LM Studio, Ollama, even on
 *     a LAN address) or pointed at this machine.
 *  3. `missing`: it talks to a service that always wants a key and has
 *     none. That is a cloud kind (`openrouter`, `aimlapi`, `gemini`) on
 *     the vendor's own endpoint, an entry that declares its own
 *     `apiKeyEnvVar` (it said it needs a key; every cloud preset entry the
 *     wizard saves declares one), or an entry made from a cloud preset
 *     that still points at that preset's host.
 *  4. `unverified`: no key, and nothing says whether one is needed. A
 *     hand-made entry for a server on the LAN, a cloud kind behind an
 *     overridden endpoint (a proxy may hold the key itself), a
 *     `llama-server` entry. Callers that act on a missing key leave these
 *     alone; a check for "ready to serve" does not count them.
 *
 * Pure apart from reading `process.env` through `resolveLlmProviderApiKey`
 * when `keyFrom` is `"resolve"`.
 */
export type ProviderKeyStatus =
  | { readonly state: "present" }
  | { readonly state: "not-needed" }
  | {
      readonly state: "missing";
      /** The entry's declared env var, when it declares one. */
      readonly envVar: string | null;
    }
  | { readonly state: "unverified" };

/**
 * The fields the rule reads. Both a user-config entry and a resolved
 * runtime entry fit (the runtime entry is the user entry spread, with the
 * key resolved into `apiKey`).
 */
export interface ProviderKeySubject {
  readonly id: string;
  readonly kind: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnvVar?: string;
  readonly apiKeyHeader?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly subscriptionCli?: UserSubscriptionCliOptions;
}

export interface ProviderKeyOptions {
  /**
   * Where the key comes from. `"resolve"` (the default) asks
   * `resolveLlmProviderApiKey`, so a user-config entry is judged by the
   * key its env var holds. `"entry"` reads only `apiKey`: for a resolved
   * runtime entry that is the very value the provider factory sends, so
   * "no key here" means no key goes out.
   */
  readonly keyFrom?: "resolve" | "entry";
}

/**
 * Kinds that only ever talk to the vendor's own cloud API, which answers
 * every request without a key with a 401.
 */
export const KEYED_CLOUD_KINDS: ReadonlySet<string> = new Set([
  "openrouter",
  "aimlapi",
  "gemini",
]);

/**
 * A header name that may carry a credential an entry sets by hand
 * (`authorization`, `x-api-key`, `x-goog-api-key`, `x-auth-token`, ...).
 * Broad on purpose: a false match only means the entry is not called
 * keyless.
 */
const CREDENTIAL_HEADER = /key|auth|token/i;

export function providerKeyStatus(
  entry: ProviderKeySubject,
  options: ProviderKeyOptions = {},
): ProviderKeyStatus {
  if (hasCredential(entry, options.keyFrom ?? "resolve")) {
    return { state: "present" };
  }
  if (usesExternalCliAuth(entry)) return { state: "not-needed" };
  const preset = presetForEntryId(entry.id);
  if (preset?.local || isLocalProviderUrl(entry.baseUrl)) {
    return { state: "not-needed" };
  }
  const envVar = declaredEnvVar(entry);
  const needsKey =
    (KEYED_CLOUD_KINDS.has(entry.kind) && !entry.baseUrl) ||
    envVar !== null ||
    (preset !== undefined &&
      hostOf(entry.baseUrl) !== null &&
      hostOf(entry.baseUrl) === hostOf(preset.baseUrl));
  return needsKey ? { state: "missing", envVar } : { state: "unverified" };
}

/** Shorthand: the entry needs a key and has none. */
export function providerKeyMissing(
  entry: ProviderKeySubject,
  options: ProviderKeyOptions = {},
): boolean {
  return providerKeyStatus(entry, options).state === "missing";
}

function hasCredential(
  entry: ProviderKeySubject,
  keyFrom: "resolve" | "entry",
): boolean {
  const key =
    keyFrom === "entry"
      ? entry.apiKey
      : resolveLlmProviderApiKey({
          id: entry.id,
          kind: entry.kind,
          ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
          ...(entry.apiKeyEnvVar !== undefined
            ? { apiKeyEnvVar: entry.apiKeyEnvVar }
            : {}),
        });
  if (typeof key === "string" && key.trim().length > 0) return true;
  const named = entry.apiKeyHeader?.trim().toLowerCase();
  // Read defensively: this runs on every fallback pick, and a hand-edited
  // config with a non-string header value must not stop every turn.
  return Object.entries(entry.headers ?? {}).some(([name, value]) => {
    const lower = name.trim().toLowerCase();
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      (CREDENTIAL_HEADER.test(lower) || lower === named)
    );
  });
}

function declaredEnvVar(entry: ProviderKeySubject): string | null {
  const name = entry.apiKeyEnvVar;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
