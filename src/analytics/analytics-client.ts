import { PostHog } from "posthog-node";

import {
  POSTHOG_HOST,
  POSTHOG_PLACEHOLDER_KEY,
  POSTHOG_PROJECT_KEY,
} from "./posthog-config.js";
import { isAnalyticsKilledByEnv } from "./read-analytics-kill-switch.js";
import type { AnalyticsDimensions } from "./resolve-analytics-dimensions.js";

/**
 * Sentinel IP sent as the `$ip` event property. Overriding with a truthy
 * placeholder is the only client-side lever that prevents PostHog from
 * storing the request's real IP (see the class doc for why `null` fails).
 */
const IP_PLACEHOLDER = "0.0.0.0";

/** Minimal logger surface so this module does not depend on the tracing package. */
export interface AnalyticsLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface AnalyticsClientOptions {
  /** Anonymous, stable-per-install identifier used as the distinctId. */
  installId: string;
  /** OS platform tag stamped on every event (e.g. `darwin` / `linux` / `win32`). */
  platform: string;
  /** App version stamped on every event as `app_version` (e.g. `1.2.3`). */
  version: string;
  /**
   * Process-wide dimensions (`surface`, `arch`, `install_channel`,
   * `desktop_version`) stamped on every event. `arch` falls back to
   * `process.arch` when omitted.
   */
  dimensions?: AnalyticsDimensions;
  logger?: AnalyticsLogger;
  /** Test seam — inject a fake PostHog implementation. */
  posthog?: Pick<PostHog, "capture" | "shutdown">;
}

/**
 * Thin privacy-hardened wrapper over `posthog-node`. Every event is:
 *   - attributed to the anonymous `installId` (no user/device linkage);
 *   - sent with `disableGeoip: true` (no location enrichment — also the
 *     library default as of posthog-node v3, set explicitly for clarity);
 *   - stamped with `$ip: "0.0.0.0"` so PostHog persists a placeholder instead
 *     of the machine's real public IP. PostHog's ingestion only honors a
 *     truthy `$ip` override — a falsy value (`null`/empty) is ignored and the
 *     request IP is captured instead, so the override must be a real string;
 *   - stamped with the `platform` OS tag (`darwin` / `linux` / `win32`);
 *   - stamped with the `app_version` tag (the running app version);
 *   - stamped with `arch`, and — when dimensions are given — `surface`,
 *     `install_channel` and `desktop_version` (desktop only).
 *
 * The client is fire-safe: capture failures are swallowed so an
 * analytics outage never disturbs the agent runtime.
 */
export class AnalyticsClient {
  private readonly posthog: Pick<PostHog, "capture" | "shutdown">;
  private readonly installId: string;
  private readonly platform: string;
  private readonly version: string;
  private readonly globals: Record<string, string>;
  private readonly logger?: AnalyticsLogger;

  constructor(options: AnalyticsClientOptions) {
    this.installId = options.installId;
    this.platform = options.platform;
    this.version = options.version;
    this.globals = globalProperties(options.dimensions);
    if (options.logger) this.logger = options.logger;
    this.posthog =
      options.posthog ??
      new PostHog(POSTHOG_PROJECT_KEY, {
        host: POSTHOG_HOST,
        disableGeoip: true,
        // Local desktop/CLI runtime — flush eagerly so short-lived CLI
        // processes deliver events before exit.
        flushAt: 1,
      });
  }

  capture(event: string, properties: Record<string, unknown> = {}): void {
    try {
      this.posthog.capture({
        distinctId: this.installId,
        event,
        properties: {
          ...properties,
          // Surface / arch / install channel / desktop version. After the
          // caller's props so an event can never override them.
          ...this.globals,
          // OS platform dimension, stamped on every event.
          platform: this.platform,
          // App version dimension, stamped on every event.
          app_version: this.version,
          // Overrides PostHog's server-side IP capture with a placeholder so
          // the machine's real public IP is never stored. PostHog only honors
          // a truthy `$ip` override — a `null`/falsy value is ignored and the
          // request IP is used instead, so the sentinel MUST be a real string.
          $ip: IP_PLACEHOLDER,
        },
        disableGeoip: true,
      });
    } catch (err) {
      this.logger?.warn("analytics: capture failed", {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.posthog.shutdown();
    } catch (err) {
      this.logger?.warn("analytics: shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Construct an {@link AnalyticsClient}, or return `null` when analytics is
 * disabled by config, forced off by `ATOMIC_AGENT_ANALYTICS=off`, or the
 * project key is the placeholder sentinel. A `null` client is the
 * runtime's "analytics off" signal — callers guard on it before emitting
 * events.
 */
export function createAnalyticsClient(options: {
  enabled: boolean;
  installId: string;
  platform: string;
  version: string;
  dimensions?: AnalyticsDimensions;
  logger?: AnalyticsLogger;
  posthog?: Pick<PostHog, "capture" | "shutdown">;
  /** Test seam for the kill-switch env (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}): AnalyticsClient | null {
  if (!options.enabled) return null;
  if (isAnalyticsKilledByEnv(options.env)) return null;
  // Never open a real connection under the test runner — otherwise the
  // suite would pollute production analytics on every run. An injected
  // fake `posthog` bypasses this guard for the module's own unit tests.
  if (!options.posthog && isTestEnvironment()) return null;
  if (!options.posthog && POSTHOG_PROJECT_KEY === POSTHOG_PLACEHOLDER_KEY) {
    return null;
  }
  return new AnalyticsClient({
    installId: options.installId,
    platform: options.platform,
    version: options.version,
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.posthog ? { posthog: options.posthog } : {}),
  });
}

/** Event properties derived from the process-wide dimensions. */
function globalProperties(
  dimensions: AnalyticsDimensions | undefined,
): Record<string, string> {
  const props: Record<string, string> = {
    arch: dimensions?.arch ?? process.arch,
  };
  if (!dimensions) return props;
  props.surface = dimensions.surface;
  props.install_channel = dimensions.installChannel;
  if (dimensions.desktopVersion !== undefined) {
    props.desktop_version = dimensions.desktopVersion;
  }
  return props;
}

/** True when running under Vitest / `NODE_ENV=test`. */
function isTestEnvironment(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
}
