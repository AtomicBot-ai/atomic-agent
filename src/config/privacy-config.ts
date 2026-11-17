import { parseBool } from "./config-primitives.js";

/**
 * `privacy` block of config.json (unversioned, additive, ATO-599).
 *
 * - `shield.enabled` (default `false`): Privacy Shield. Personal data and
 *   keys in a request to a cloud model are swapped for placeholders
 *   (`[EMAIL_1]`, `[CARD_1]`, `[SECRET_1]`) and put back in the reply
 *   and in tool calls on this machine. See `src/privacy/README.md`.
 */
export interface PrivacyShieldConfig {
  /**
   * Privacy Shield (ATO-599): when `true`, emails, phone numbers, card
   * numbers, IBANs and keys in a request to a cloud model are replaced
   * with placeholders such as `[EMAIL_1]` and put back in the reply on
   * this machine. Off by default. Local models always get the real text.
   */
  enabled: boolean;
}

export interface PrivacyConfig {
  shield: PrivacyShieldConfig;
}

export function createPrivacyDefaults(): PrivacyConfig {
  return { shield: { enabled: false } };
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
    },
  };
}
