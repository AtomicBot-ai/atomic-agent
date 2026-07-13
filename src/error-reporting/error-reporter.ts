import { scrubError } from "./error-scrubber.js";
import type { SentryClient } from "./sentry-client.js";

let globalHandlersInstalled = false;

/**
 * Capture an error through the (possibly `null`) client. No-ops when
 * reporting is disabled. `cancelled` failures are intentionally dropped —
 * they are user-initiated, not defects. Non-`Error` thrown values are
 * never stringified (that could leak user data): they are reported as a
 * fixed `NonError` type with no message.
 */
export function captureError(
  client: SentryClient | null,
  err: unknown,
  opts: { source: string; category?: string },
): void {
  if (!client) return;
  if (opts.category === "cancelled") return;
  const error =
    err instanceof Error
      ? err
      : Object.assign(new Error("non-error value thrown"), {
          name: "NonError",
        });
  const scrubbed = scrubError(error, opts);
  if (scrubbed.category === "cancelled") return;
  client.capture(scrubbed);
}

/**
 * Install process-global `uncaughtException` / `unhandledRejection`
 * handlers that report through the client resolved by `getClient` at
 * capture time. The getter (rather than a captured value) is what lets
 * the runtime hot-toggle analytics on/off without re-installing the
 * process handlers — the handler always sees the *current* client, or
 * `null` when reporting is disabled (in which case capture no-ops).
 * Idempotent: the handlers are installed exactly once per process.
 *
 * Crash semantics are preserved conservatively: the fatal exit path is
 * only taken for `uncaughtException` when this runtime installed the sole
 * handler (i.e. no other listener was registered before us). If a host
 * (e.g. the Tauri sidecar) already handles these, we only capture and let
 * the host decide — we never turn a fatal crash into a silent zombie nor
 * kill a process the host expected to keep running.
 */
export function installGlobalErrorHandlers(
  getClient: () => SentryClient | null,
): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;

  const soleUncaughtHandler =
    process.listenerCount("uncaughtException") === 0;

  process.on("uncaughtException", (err) => {
    const client = getClient();
    captureError(client, err, { source: "uncaughtException" });
    if (soleUncaughtHandler) {
      // Preserve Node's default fatal behavior: flush best-effort (only
      // when a client is present), print the stack to local stderr, then
      // exit non-zero.
      const flushed = client ? client.flush(2000) : Promise.resolve();
      void flushed.finally(() => {
        try {
          process.stderr.write(`${err?.stack ?? err}\n`);
        } catch {
          // stderr already closed — nothing else to do.
        }
        process.exit(1);
      });
    }
  });

  process.on("unhandledRejection", (reason) => {
    captureError(getClient(), reason, { source: "unhandledRejection" });
    // Deliberately non-fatal: an unhandled rejection should not tear down
    // a long-lived agent. Capturing is enough for observability.
  });
}

/** Test-only reset of the idempotency guard. */
export function resetGlobalErrorHandlersForTests(): void {
  globalHandlersInstalled = false;
}
