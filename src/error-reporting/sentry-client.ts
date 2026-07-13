import {
  SENTRY_DSN,
  SENTRY_PLACEHOLDER_DSN,
  parseSentryDsn,
  type ParsedSentryDsn,
} from "./sentry-config.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import { buildEnvelope, buildSentryAuthHeader } from "./sentry-envelope.js";

/** Minimal logger surface so this module does not depend on the tracing package. */
export interface ErrorReportLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Subset of the global `fetch` this client relies on (test seam). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface SentryClientOptions {
  dsn: ParsedSentryDsn;
  installId: string;
  release: string;
  platform: string;
  logger?: ErrorReportLogger;
  fetchImpl?: FetchLike;
}

/**
 * Thin, privacy-hardened Sentry ingest client. It POSTs a hand-built
 * envelope (see `sentry-envelope.ts`) — it does NOT pull in `@sentry/node`
 * whose OpenTelemetry auto-instrumentation relies on `import-in-the-middle`
 * loader hooks that cannot work inside the single-file, bundled SEA
 * binary. Every send is fire-and-forget and fire-safe: a reporting outage
 * never disturbs the agent runtime.
 */
export class SentryClient {
  private readonly fetchImpl: FetchLike;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: SentryClientOptions) {
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => fetch(input, init) as Promise<{ ok: boolean; status: number }>);
  }

  capture(event: ScrubbedErrorEvent): void {
    try {
      const { body } = buildEnvelope(this.options.dsn, event, {
        installId: this.options.installId,
        release: this.options.release,
        platform: this.options.platform,
      });
      const promise = this.send(body)
        .catch((err) => {
          this.options.logger?.warn("error-reporting: send failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.pending.delete(promise);
        });
      this.pending.add(promise);
    } catch (err) {
      this.options.logger?.warn("error-reporting: capture failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async send(body: string): Promise<void> {
    await this.fetchImpl(this.options.dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": buildSentryAuthHeader(
          this.options.dsn,
          this.options.release,
        ),
      },
      body,
    });
  }

  /** Await in-flight sends up to `timeoutMs`; never rejects. */
  async flush(timeoutMs = 2000): Promise<void> {
    if (this.pending.size === 0) return;
    const inflight = Promise.allSettled([...this.pending]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([inflight, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

/**
 * Construct a {@link SentryClient}, or return `null` when error reporting
 * is disabled by config, the DSN is the placeholder sentinel, or the DSN
 * is malformed. A `null` client is the runtime's "reporting off" signal —
 * callers guard on it before capturing.
 */
export function createSentryClient(options: {
  enabled: boolean;
  installId: string;
  release: string;
  platform: string;
  dsn?: string;
  logger?: ErrorReportLogger;
  fetchImpl?: FetchLike;
}): SentryClient | null {
  if (!options.enabled) return null;
  // Never open a real connection under the test runner — otherwise the
  // suite would ping production Sentry. An injected `fetchImpl` bypasses
  // this guard for the module's own unit tests.
  if (!options.fetchImpl && isTestEnvironment()) return null;
  const raw = options.dsn ?? SENTRY_DSN;
  if (raw === SENTRY_PLACEHOLDER_DSN) return null;
  const parsed = parseSentryDsn(raw);
  if (!parsed) {
    options.logger?.warn("error-reporting: invalid Sentry DSN, disabled");
    return null;
  }
  return new SentryClient({
    dsn: parsed,
    installId: options.installId,
    release: options.release,
    platform: options.platform,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/** True when running under Vitest / `NODE_ENV=test`. */
function isTestEnvironment(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
}
