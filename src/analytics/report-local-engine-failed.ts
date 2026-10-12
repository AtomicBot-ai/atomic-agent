import { resolve } from "node:path";

import type { PostHog } from "posthog-node";

import { createAnalyticsClient } from "./analytics-client.js";
import {
  captureLocalEngineFailed,
  type LocalEngineFailedContext,
} from "./analytics-events.js";
import { AnalyticsStateStore } from "./analytics-state-store.js";
import { isAnalyticsKilledByEnv } from "./read-analytics-kill-switch.js";
import { resolveAnalyticsDimensions } from "./resolve-analytics-dimensions.js";

const FLUSH_TIMEOUT_MS = 2000;

/**
 * Send `local_engine_failed` from a process that has no live runtime: a
 * one-shot `models start` / `models update` (the desktop app drives local
 * models through them). Builds a one-shot client, captures the event and
 * waits a bounded time for the flush. Never throws. A no-op when
 * `enabled` is false (the operator's `analytics.enabled`), under
 * `ATOMIC_AGENT_ANALYTICS=off`, and under the test runner unless a fake
 * `posthog` is injected.
 */
export async function reportLocalEngineFailed(options: {
  stateDir: string;
  version: string;
  enabled: boolean;
  context: LocalEngineFailedContext;
  posthog?: Pick<PostHog, "capture" | "shutdown">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    if (!options.enabled || isAnalyticsKilledByEnv(options.env)) return;
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
    captureLocalEngineFailed(client, options.context);
    // Bounded: an offline machine must not stall the command it reports on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.shutdown(),
      new Promise<void>((done) => {
        timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    // Analytics is best-effort; the command's own outcome stands.
  }
}
