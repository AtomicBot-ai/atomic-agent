import { resolve } from "node:path";

import type { PostHog } from "posthog-node";

import { createAnalyticsClient } from "./analytics-client.js";
import {
  captureAnalyticsDisabled,
  type AnalyticsDisabledVia,
} from "./analytics-events.js";
import { AnalyticsStateStore } from "./analytics-state-store.js";
import { isAnalyticsKilledByEnv } from "./read-analytics-kill-switch.js";
import { resolveAnalyticsDimensions } from "./resolve-analytics-dimensions.js";

const FLUSH_TIMEOUT_MS = 2000;

/**
 * Send `analytics_disabled` from a process that has no live runtime —
 * `atomic-agent config set analytics.enabled false`. Builds a one-shot
 * client, captures the event, and waits for the flush. Call it BEFORE the
 * new config is written. Never throws. A no-op under
 * `ATOMIC_AGENT_ANALYTICS=off`, and under the test runner unless a fake
 * `posthog` is injected (so the suite never writes `analytics.json` into
 * a real state dir).
 */
export async function reportAnalyticsOptOut(options: {
  stateDir: string;
  version: string;
  via: AnalyticsDisabledVia;
  posthog?: Pick<PostHog, "capture" | "shutdown">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    // Forced off for this process: send nothing, write nothing.
    if (isAnalyticsKilledByEnv(options.env)) return;
    const underTest =
      process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
    if (underTest && !options.posthog) return;
    const dimensions = resolveAnalyticsDimensions({
      stateDir: options.stateDir,
      ...(options.env ? { env: options.env } : {}),
    });
    const store = new AnalyticsStateStore(
      resolve(options.stateDir, "analytics.json"),
    );
    const client = createAnalyticsClient({
      enabled: true,
      installId: store.getSharedInstallId(true, dimensions.surface),
      platform: process.platform,
      version: options.version,
      dimensions,
      ...(options.posthog ? { posthog: options.posthog } : {}),
    });
    if (!client) return;
    captureAnalyticsDisabled(client, store, options.via);
    // Bounded: an offline machine must not stall `config set`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.shutdown(),
      new Promise<void>((done) => {
        timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    // Analytics is best-effort; the config write must still happen.
  }
}
