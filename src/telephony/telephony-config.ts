/**
 * Phone calls through the user's own telephony account (ATO-24, decided
 * 18.11.2026): the user brings the provider key and the caller number;
 * we run no telephony account and pay for no calls. Twilio first.
 *
 * Read from the environment or `<stateDir>/.env`, like every other
 * provider secret, so nothing new goes into `config.json`:
 *
 *  - `TWILIO_ACCOUNT_SID`  `AC` + 32 hex characters
 *  - `TWILIO_AUTH_TOKEN`   the account's auth token (or an API key secret)
 *  - `TWILIO_FROM_NUMBER`  a voice-capable number on that account, E.164
 *
 * Any one missing means calls are off; the reason names what is missing
 * and never echoes a value.
 */

export const TWILIO_ENV = {
  accountSid: "TWILIO_ACCOUNT_SID",
  authToken: "TWILIO_AUTH_TOKEN",
  fromNumber: "TWILIO_FROM_NUMBER",
} as const;

export interface TwilioConfig {
  provider: "twilio";
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export type TelephonyConfigResult =
  | { ok: true; config: TwilioConfig }
  | { ok: false; reason: string };

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
/** E.164: `+`, country code first, 8 to 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Spaces, dashes, dots and parentheses are dropped; the rest must be E.164. */
export function normalizePhoneNumber(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-.()]/g, "");
  return E164.test(compact) ? compact : null;
}

export function readTelephonyConfig(
  env: Readonly<Record<string, string | undefined>>,
): TelephonyConfigResult {
  const accountSid = env[TWILIO_ENV.accountSid]?.trim() ?? "";
  const authToken = env[TWILIO_ENV.authToken]?.trim() ?? "";
  const fromRaw = env[TWILIO_ENV.fromNumber]?.trim() ?? "";
  const missing = (Object.keys(TWILIO_ENV) as Array<keyof typeof TWILIO_ENV>)
    .filter((k) => ({ accountSid, authToken, fromNumber: fromRaw })[k] === "")
    .map((k) => TWILIO_ENV[k]);
  if (missing.length > 0) {
    return { ok: false, reason: `phone calls are off: set ${missing.join(", ")}` };
  }
  if (!ACCOUNT_SID.test(accountSid)) {
    return { ok: false, reason: `${TWILIO_ENV.accountSid} does not look like a Twilio account SID (AC…)` };
  }
  const fromNumber = normalizePhoneNumber(fromRaw);
  if (!fromNumber) {
    return { ok: false, reason: `${TWILIO_ENV.fromNumber} must be an E.164 number, e.g. +14155550100` };
  }
  return { ok: true, config: { provider: "twilio", accountSid, authToken, fromNumber } };
}
