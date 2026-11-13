/**
 * Outbound Bot Framework calls for the Teams channel (ATO-506).
 *
 * A token comes from the Entra client-credentials flow for the user's
 * own app registration (`botframework.com` tenant for a multi-tenant
 * bot, `options.tenantId` for a single-tenant one) and is cached until
 * shortly before it expires. Activities go to
 * `{serviceUrl}/v3/conversations/{id}/activities[/{replyToId}]`.
 *
 * The bearer token is only ever sent to a `serviceUrl` that arrived in
 * an authenticated inbound activity (`isAllowedServiceUrl`): the service
 * URL comes from the request body, and without that check a forged
 * activity could make us hand our token to any host.
 */

import { chunkMessage } from "../discord/discord-channel-types.js";
import { normalizeServiceUrl } from "./msteams-jwt.js";
import { MSTEAMS_MESSAGE_LIMIT, type TeamsTarget } from "./msteams-types.js";

export const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const DEFAULT_TENANT = "botframework.com";
/** Refresh this long before `expires_in` runs out. */
const TOKEN_EARLY_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 30_000;

export class TeamsApiError extends Error {
  /** `http_<status>`, `token_<error>`, `service_url_not_allowed`, ... */
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? `Teams API error: ${code}`);
    this.name = "TeamsApiError";
    this.code = code;
  }
}

export interface TeamsApiOptions {
  appId: string;
  appPassword: string;
  /** Single-tenant directory id; `null` uses the multi-tenant `botframework.com`. */
  tenantId: string | null;
  /** True for a service URL seen in an authenticated inbound activity. */
  isAllowedServiceUrl: (normalizedUrl: string) => boolean;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class TeamsApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: TeamsApiOptions) {}

  /** A connector token, cached. Throws `TeamsApiError` (`token_invalid_client`, ...) on refusal. */
  async getToken(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.token && now < this.token.expiresAt) return this.token.value;
    const url =
      this.opts.tokenUrl ??
      `https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenantId ?? DEFAULT_TENANT)}/oauth2/v2.0/token`;
    const res = await this.fetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.opts.appId,
        client_secret: this.opts.appPassword,
        scope: BOT_FRAMEWORK_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = body.access_token;
    if (!res.ok || typeof accessToken !== "string") {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      throw new TeamsApiError(`token_${code}`, `Microsoft sign-in refused the bot credentials (${code}).`);
    }
    const ttlS = Number(body.expires_in ?? 3600);
    this.token = {
      value: accessToken,
      expiresAt: now + Math.max(60_000, (Number.isFinite(ttlS) ? ttlS : 3600) * 1000 - TOKEN_EARLY_MS),
    };
    return this.token.value;
  }

  /** Post one activity; returns the new activity id when the service gives one. */
  async sendActivity(target: TeamsTarget, activity: Record<string, unknown>): Promise<string | null> {
    const suffix = target.replyToId ? `/${encodeURIComponent(target.replyToId)}` : "";
    const body = await this.call("POST", target, suffix, activity);
    return typeof body.id === "string" ? body.id : null;
  }

  /** Replace an activity we posted (an answered approval card). */
  async updateActivity(target: TeamsTarget, activityId: string, activity: Record<string, unknown>): Promise<void> {
    await this.call("PUT", target, `/${encodeURIComponent(activityId)}`, { ...activity, id: activityId });
  }

  /** Post markdown `text` split into message-sized chunks, in order. */
  async postText(target: TeamsTarget, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, MSTEAMS_MESSAGE_LIMIT)) {
      await this.sendActivity(target, { type: "message", textFormat: "markdown", text: chunk });
    }
  }

  private async call(
    method: "POST" | "PUT",
    target: TeamsTarget,
    suffix: string,
    activity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const base = normalizeServiceUrl(target.serviceUrl);
    if (!base.startsWith("https://") || !this.opts.isAllowedServiceUrl(base)) {
      throw new TeamsApiError("service_url_not_allowed", "Refusing to send to a service URL no authenticated activity came from.");
    }
    const url = `${base}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities${suffix}`;
    const maxRetries = this.opts.maxRateLimitRetries ?? 2;
    let reauthed = false;
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetch()(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(activity),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
      if (res.status === 401 && !reauthed) {
        // A token revoked or rotated early: fetch a fresh one once.
        reauthed = true;
        this.token = null;
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const waitMs = retryAfterMs(res.headers.get("retry-after"));
        if (attempt >= maxRetries || waitMs > MAX_RETRY_AFTER_MS) {
          throw new TeamsApiError(`http_${res.status}`, `Teams throttled the reply (HTTP ${res.status}).`);
        }
        await (this.opts.sleep ?? defaultSleep)(waitMs);
        continue;
      }
      if (!res.ok) throw new TeamsApiError(`http_${res.status}`, `Teams returned HTTP ${res.status}.`);
      const text = await res.text();
      if (text.trim() === "") return {};
      try {
        const parsed = JSON.parse(text) as unknown;
        return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
  }

  private fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }
}

/** `Retry-After` in seconds; missing or odd waits one second. */
export function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return 1000;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
