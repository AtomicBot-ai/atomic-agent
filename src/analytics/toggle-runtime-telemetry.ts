import {
  createSentryClient,
  type ErrorReportLogger,
  type SentryClient,
} from "../error-reporting/index.js";
import {
  createAnalyticsClient,
  type AnalyticsClient,
  type AnalyticsLogger,
} from "./analytics-client.js";
import {
  captureAnalyticsDisabled,
  type AnalyticsDisabledVia,
} from "./analytics-events.js";
import type { AnalyticsStateStore } from "./analytics-state-store.js";
import { isAnalyticsKilledByEnv } from "./read-analytics-kill-switch.js";
import type { AnalyticsDimensions } from "./resolve-analytics-dimensions.js";

/** The runtime's two telemetry clients; `null` means "off". */
export interface RuntimeTelemetry {
  analytics: AnalyticsClient | null;
  errorReporter: SentryClient | null;
}

/** Test seam: the client factories (default: the real ones). */
export interface RuntimeTelemetryFactories {
  createAnalyticsClient: typeof createAnalyticsClient;
  createSentryClient: typeof createSentryClient;
}

const DEFAULT_FACTORIES: RuntimeTelemetryFactories = {
  createAnalyticsClient,
  createSentryClient,
};

/**
 * Build PostHog + Sentry for this process, sharing one opt-out and one
 * install id. `ATOMIC_AGENT_ANALYTICS=off` forces both off (and keeps
 * the shared id file untouched) whatever `enabled` says.
 */
export function buildRuntimeTelemetry(options: {
  enabled: boolean;
  store: AnalyticsStateStore;
  dimensions: AnalyticsDimensions;
  version: string;
  logger?: AnalyticsLogger & ErrorReportLogger;
  env?: NodeJS.ProcessEnv;
  factories?: RuntimeTelemetryFactories;
}): RuntimeTelemetry {
  const factories = options.factories ?? DEFAULT_FACTORIES;
  const enabled = options.enabled && !isAnalyticsKilledByEnv(options.env);
  const installId = options.store.getSharedInstallId(
    enabled,
    options.dimensions.surface,
  );
  const logger = options.logger ? { logger: options.logger } : {};
  return {
    analytics: factories.createAnalyticsClient({
      enabled,
      installId,
      platform: process.platform,
      version: options.version,
      dimensions: options.dimensions,
      ...logger,
    }),
    errorReporter: factories.createSentryClient({
      enabled,
      installId,
      release: options.version,
      platform: process.platform,
      dimensions: options.dimensions,
      ...logger,
    }),
  };
}

/**
 * The runtime's live analytics switch (`AgentRuntime.setAnalyticsEnabled`).
 * Idempotent against the live intent. Turning off sends
 * `analytics_disabled` exactly once, BEFORE the clients are shut down, so
 * the shutdown flushes it; turning on rebuilds the clients and calls
 * `onEnabled` (the caller fires the once-only `app_installed`). Resolves
 * to whether anything changed.
 */
export function createTelemetryToggle(options: {
  initialEnabled: boolean;
  store: AnalyticsStateStore;
  get: () => RuntimeTelemetry;
  set: (next: RuntimeTelemetry) => void;
  rebuild: () => RuntimeTelemetry;
  onEnabled?: () => void;
}): (enabled: boolean, via?: AnalyticsDisabledVia) => Promise<boolean> {
  let live = options.initialEnabled;
  return async (enabled, via = "settings") => {
    if (enabled === live) return false;
    live = enabled;
    const current = options.get();
    if (!enabled) {
      captureAnalyticsDisabled(current.analytics, options.store, via);
    }
    // Detach first so nothing new lands on a client being shut down.
    options.set({ analytics: null, errorReporter: null });
    // Fire-safe: both `shutdown`s swallow their own errors.
    if (current.analytics) await current.analytics.shutdown();
    if (current.errorReporter) await current.errorReporter.shutdown();
    if (enabled) {
      options.set(options.rebuild());
      options.onEnabled?.();
    }
    return true;
  };
}
