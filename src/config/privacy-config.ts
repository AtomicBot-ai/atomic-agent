import { parseBool } from "./config-primitives.js";

/**
 * `privacy` block of config.json (unversioned, additive, ATO-599).
 *
 * - `shield.enabled` (default `false`): Privacy Shield. Personal data and
 *   keys in a request to a cloud model are swapped for placeholders
 *   (`[EMAIL_1]`, `[CARD_1]`, `[SECRET_1]`) and put back in the reply
 *   and in tool calls on this machine. See `src/privacy/README.md`.
 * - `shield.localNames` (default `false`): with the shield on, a local
 *   model also finds names, street addresses and organisations
 *   (ATO-2394).
 */
export interface PrivacyShieldConfig {
  /**
   * Privacy Shield (ATO-599): when `true`, emails, phone numbers, card
   * numbers, IBANs and keys in a request to a cloud model are replaced
   * with placeholders such as `[EMAIL_1]` and put back in the reply on
   * this machine. Off by default. Local models always get the real text.
   */
  enabled: boolean;
  /**
   * Names, addresses and organisations (ATO-2394): when `true` and the shield is on, a model on this machine finds people's names, street addresses and organisations in a cloud request and they are masked too (`[NAME_1]`). Needs a local model; without one only the regex masks apply. Off by default.
   */
  localNames: boolean;
}

export interface PrivacyConfig {
  shield: PrivacyShieldConfig;
}

export function createPrivacyDefaults(): PrivacyConfig {
  return { shield: { enabled: false, localNames: false } };
}

export function parsePrivacyConfig(
  raw: Record<string, unknown>,
  readDefaults: () => PrivacyConfig,
): PrivacyConfig {
  const defaults = readDefaults();
  const shield =
    raw.shield !== null && typeof raw.shield === "object" && !Array.isArray(raw.shield)
      ? (raw.shield as Record<string, unknown>)
      : {};
  return {
    shield: {
      enabled: parseBool(shield.enabled ?? defaults.shield.enabled, "privacy.shield.enabled"),
      localNames: parseBool(
        shield.localNames ?? defaults.shield.localNames,
        "privacy.shield.localNames",
      ),
    },
  };
}
