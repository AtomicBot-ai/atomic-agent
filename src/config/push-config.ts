import { ConfigValidationError } from "./config-validation-error.js";

import { parseBool, parseNonEmptyString } from "./config-primitives.js";

/**
 * Phone push through an ntfy server (ATO-1129). One HTTP POST to a
 * topic on `server`; the ntfy app on the phone subscribes to the same
 * topic and rings. No bot to create, no account: the topic name is the
 * address. Unversioned, additive: an older file has no block and takes
 * the defaults, which send nothing.
 *
 * **The topic is the secret.** On the public `ntfy.sh` anyone who knows
 * a topic name can read and post to it, so `atomic-agent push on` mints
 * a random one (`generatePushTopic`) rather than asking for a word. The
 * optional access token for a self-hosted or reserved topic is not
 * stored here: it lives in `<stateDir>/.env` under `tokenEnv`, like
 * every other credential.
 */
export interface PushNotifyConfig {
  /** Master switch. `false` (the default) sends nothing. */
  enabled: boolean;
  /** ntfy server base URL, no trailing slash. */
  server: string;
  /** Topic to publish to; `null` until push is turned on. */
  topic: string | null;
  /** Name of the env var holding an optional ntfy access token. */
  tokenEnv: string;
}

export const DEFAULT_PUSH_SERVER = "https://ntfy.sh";

/** ntfy's own rule for a topic name. */
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export function isValidPushTopic(raw: string): boolean {
  return TOPIC_RE.test(raw);
}

export function createPushDefaults(): PushNotifyConfig {
  return {
    enabled: false,
    server: DEFAULT_PUSH_SERVER,
    topic: null,
    tokenEnv: "NTFY_TOKEN",
  };
}

/** An http(s) URL with the trailing slashes trimmed, or a config error. */
export function parsePushServer(raw: unknown, field: string): string {
  const text = parseNonEmptyString(raw, field).trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigValidationError(field, `expected an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigValidationError(field, `expected an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password) {
    // A password in config.json is a credential outside `.env`.
    throw new ConfigValidationError(field, "put the access token in .env (tokenEnv), not in the URL");
  }
  return text.replace(/\/+$/, "");
}

function parsePushTopic(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new ConfigValidationError(field, "expected a string or null");
  }
  const text = raw.trim();
  if (text.length === 0) return null;
  if (!isValidPushTopic(text)) {
    throw new ConfigValidationError(field, "expected 1-64 letters, digits, '-' or '_'");
  }
  return text;
}

export function parsePushConfig(
  raw: Record<string, unknown>,
  readDefaults: () => PushNotifyConfig,
): PushNotifyConfig {
  const defaults = readDefaults();
  return {
    enabled: parseBool(raw.enabled ?? defaults.enabled, "notifications.push.enabled"),
    server: parsePushServer(raw.server ?? defaults.server, "notifications.push.server"),
    topic: parsePushTopic(raw.topic, "notifications.push.topic"),
    tokenEnv: parseNonEmptyString(raw.tokenEnv ?? defaults.tokenEnv, "notifications.push.tokenEnv"),
  };
}
