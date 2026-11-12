import {
  DEFAULT_PUSH_SERVER,
  ensureUserConfigFileSync,
  getConfig,
  parsePushServer,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type PushNotifyConfig,
} from "../config/index.js";
import { generatePushTopic, pushSubscribeUrl } from "./ntfy-client.js";

/**
 * Turning phone push on and off (ATO-1129). Shared by `atomic-agent
 * push` and the TUI's download prompt, so both mint the topic the same
 * way: a random one the first time, kept on later `on`s so the phone
 * stays subscribed, replaced only on request (`--new-topic`).
 */
export interface PushSetupResult {
  push: PushNotifyConfig;
  /** What to subscribe to in the ntfy app. */
  subscribeUrl: string;
  /** A topic was minted by this call. */
  newTopic: boolean;
}

export interface PushSetupOptions {
  /** Another ntfy server (self-hosted). Omitted keeps the current one. */
  server?: string;
  /** Throw the old topic away and mint a fresh one. */
  newTopic?: boolean;
}

function persistPush(next: PushNotifyConfig): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    notifications: { ...prev.notifications, push: next },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}

export function enablePushNotifications(
  opts: PushSetupOptions = {},
): PushSetupResult {
  const current = getConfig().notifications.push;
  const server =
    opts.server !== undefined
      ? parsePushServer(opts.server, "server")
      : current.server;
  // A topic is tied to its server: moving servers mints a new one too.
  const mint =
    opts.newTopic === true || current.topic === null || server !== current.server;
  const push: PushNotifyConfig = {
    ...current,
    enabled: true,
    server,
    topic: mint ? generatePushTopic() : current.topic,
  };
  persistPush(push);
  return { push, subscribeUrl: pushSubscribeUrl(push) ?? "", newTopic: mint };
}

/** Off, topic kept: `push on` later resumes the same subscription. */
export function disablePushNotifications(): PushNotifyConfig {
  const push = { ...getConfig().notifications.push, enabled: false };
  persistPush(push);
  return push;
}

/**
 * The caveat the operator must read before relying on it: on the public
 * server a topic is readable by anyone who has its name.
 */
export function pushPrivacyNote(push: PushNotifyConfig): string {
  const host = (() => {
    try {
      return new URL(push.server).host;
    } catch {
      return push.server;
    }
  })();
  return push.server === DEFAULT_PUSH_SERVER
    ? `Topics on ${host} are public by name: anyone who learns this topic can read your pings. Keep the URL private; messages carry a short title and the start of the answer, never tool output.`
    : `Pings go to ${host}. Keep the topic private; messages carry a short title and the start of the answer, never tool output.`;
}
