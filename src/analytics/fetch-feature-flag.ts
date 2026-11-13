import {
  POSTHOG_HOST,
  POSTHOG_PLACEHOLDER_KEY,
  POSTHOG_PROJECT_KEY,
} from "./posthog-config.js";
import { parseFeatureFlagReply } from "./interview-invite.js";

/** How long a flag check may take before it reads as "off". */
export const FEATURE_FLAG_TIMEOUT_MS = 3_000;

export interface FetchFeatureFlagOptions {
  key: string;
  /** The anonymous install id. */
  distinctId: string;
  timeoutMs?: number;
  /** Test seam. Without it, nothing is fetched under the test runner. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ask PostHog whether one feature flag is on for this install
 * (`POST /flags/?v=2` with the public project key). Only the install id
 * goes out, with GeoIP off. Any failure (offline, timeout, HTTP error,
 * odd reply) is `false`. Never throws.
 *
 * The caller must already have checked that analytics is on and
 * `DO_NOT_TRACK` is not set.
 */
export async function fetchFeatureFlag(options: FetchFeatureFlagOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  if ((POSTHOG_PROJECT_KEY as string) === POSTHOG_PLACEHOLDER_KEY) return false;
  if (!options.fetchImpl && (env.VITEST !== undefined || env.NODE_ENV === "test")) {
    return false;
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FEATURE_FLAG_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await doFetch(`${POSTHOG_HOST}/flags/?v=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_PROJECT_KEY,
        distinct_id: options.distinctId,
        geoip_disable: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    return parseFeatureFlagReply(await res.json(), options.key);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sessionCache = new Map<string, Promise<boolean>>();

/** {@link fetchFeatureFlag}, asked at most once per process for a key and id. */
export function cachedFeatureFlag(options: FetchFeatureFlagOptions): Promise<boolean> {
  const cacheKey = `${options.key}\u0000${options.distinctId}`;
  const hit = sessionCache.get(cacheKey);
  if (hit) return hit;
  const pending = fetchFeatureFlag(options);
  sessionCache.set(cacheKey, pending);
  return pending;
}

/** Test seam: forget the per-process answers. */
export function resetFeatureFlagCache(): void {
  sessionCache.clear();
}
