import { resolve } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { StructuredLogger, type LogSink } from "../../tracing/structured-logger.js";
import { MetricsCollector, type MetricSink } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import {
  AnalyticsStateStore,
  buildRuntimeTelemetry,
  captureAppInstalled,
  captureAppOpened,
  captureModelConfigured,
  captureOnboardingStep,
  createTelemetryToggle,
  detectOtherSurfaceInstalled,
  resolveAnalyticsDimensions,
  type AnalyticsDisabledVia,
} from "../../analytics/index.js";
import { getAppVersion } from "../../version.js";

export function createRuntimeObservability(
  config: AtomicAgentConfig,
  options: Pick<CreateAgentRuntimeOptions, "handlers" | "analyticsSurface" | "interactiveLaunch">,
) {

  const logSinks: LogSink[] = options.handlers?.logSinks ?? [];
  const metricSinks: MetricSink[] = options.handlers?.metricSinks ?? [];
  const logger = new StructuredLogger({
    level: config.log.level,
    sinks: logSinks,
  });
  const metrics = new AgentMetrics(
    new MetricsCollector({ sinks: metricSinks }),
  );

  // Anonymous product analytics (PostHog). Opt-out via
  // `config.analytics.enabled = false`. The client is `null` when
  // disabled; every event carries only an anonymous install id plus
  // `{ provider, model }` — never message content, paths, args, or IP
  // (see `src/analytics/`). Fire the one-time `app_installed` event on
  // the first boot of a fresh install.
  const analyticsStateStore = new AnalyticsStateStore(
    resolve(config.paths.stateDir, "analytics.json"),
  );
  // Surface / arch / install channel / desktop version, stamped on every
  // event and error report. The install id is the machine-wide one
  // shared with the other surface (desktop <-> terminal).
  const analyticsDimensions = resolveAnalyticsDimensions({
    stateDir: config.paths.stateDir,
    ...(options.analyticsSurface ? { surface: options.analyticsSurface } : {}),
  });
  const appInstalledContext = () => ({
    installChannel: analyticsDimensions.installChannel,
    otherSurfaceInstalled: detectOtherSurfaceInstalled(
      analyticsDimensions.surface,
    ),
  });
  // Both clients are `let` (not `const`) so `setAnalyticsEnabled` can
  // hot-swap them without a process restart. The `runTurn` / `onEvent` /
  // `shutdown` closures read these variables at call time, so a reassign
  // is picked up on the next event.
  //
  // Anonymous error reporting (Sentry) shares the opt-out flag
  // (`config.analytics.enabled`, or `ATOMIC_AGENT_ANALYTICS=off` for the
  // process) and the anonymous install id with product analytics. Strict
  // allowlist: only error type / category / safe scalar codes /
  // path-stripped stack frames ever leave the machine — never message
  // content, paths, tool args, or IP (see `src/error-reporting/`). Each
  // client is `null` when disabled or its key/DSN is the placeholder.
  const buildTelemetry = (enabled: boolean) =>
    buildRuntimeTelemetry({
      enabled,
      store: analyticsStateStore,
      dimensions: analyticsDimensions,
      version: getAppVersion(),
      logger,
    });
  let { analytics, errorReporter } = buildTelemetry(config.analytics.enabled);
  captureAppInstalled(analytics, analyticsStateStore, appInstalledContext());
  // Every interactive launch, not just the first: `app_installed` alone
  // cannot tell a download that never ran from one that ran and stalled.
  // Gated on the entry point opting in, so a cron task or a `serve`
  // process does not read as somebody opening the app.
  if (options.interactiveLaunch === true) {
    captureAppOpened(analytics);
  }

  const createControls = () => {

    /**
     * Hot-toggle anonymous analytics (PostHog) and error reporting
     * (Sentry). Persisting the flag to `config.json` is the caller's job
     * (the TUI settings tab); this only rebuilds the in-memory clients so
     * the change applies without a restart. Idempotent against the live
     * intent; turning off sends `analytics_disabled` first (see
     * `createTelemetryToggle`).
     */
    const toggleTelemetry = createTelemetryToggle({
      initialEnabled: config.analytics.enabled,
      store: analyticsStateStore,
      get: () => ({ analytics, errorReporter }),
      set: (next) => {
        ({ analytics, errorReporter } = next);
      },
      rebuild: () => buildTelemetry(true),
      // Fire the one-time `app_installed` event if it never went out
      // while analytics was disabled (guarded by the state store).
      onEnabled: () =>
        captureAppInstalled(
          analytics,
          analyticsStateStore,
          appInstalledContext(),
        ),
    });
    const setAnalyticsEnabled = async (
      enabled: boolean,
      via?: AnalyticsDisabledVia,
    ): Promise<void> => {
      if (await toggleTelemetry(enabled, via)) {
        logger.info("analytics toggled", { enabled });
      }
    };

    // Both read `analytics` at call time, so a hot-toggle is picked up
    // without re-registering anything.
    const reportOnboardingStep = (step: string, outcome?: string): void => {
      captureOnboardingStep(analytics, step, outcome);
    };
    const reportModelConfigured = (
      provider: string,
      kind: "local" | "cloud",
    ): void => {
      captureModelConfigured(analytics, analyticsStateStore, { provider, kind });
    };
    return { setAnalyticsEnabled, reportOnboardingStep, reportModelConfigured };
  };

  return {
    logger,
    metrics,
    analyticsStateStore,
    getAnalytics: () => analytics,
    getErrorReporter: () => errorReporter,
    createControls,
  };
}
