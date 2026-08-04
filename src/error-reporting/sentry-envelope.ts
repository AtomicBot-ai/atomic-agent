import { randomUUID } from "node:crypto";

import type { ParsedSentryDsn } from "./sentry-config.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";

/** Constant context stamped on every envelope. */
export interface EnvelopeMeta {
  /** Anonymous, stable-per-install identifier. */
  installId: string;
  /** Application release version. */
  release: string;
  /** OS platform tag (`darwin` / `linux` / `win32`). */
  platform: string;
}

/** A ready-to-send envelope: the POST body plus its event id. */
export interface BuiltEnvelope {
  eventId: string;
  body: string;
}

/**
 * Build a Sentry ingest envelope (newline-delimited JSON: envelope
 * header, item header, event payload) from a scrubbed event. Privacy
 * hardening baked in here:
 *   - `user.ip_address` is set to `null` so Sentry Relay does not
 *     backfill the sender's public IP from the request;
 *   - the anonymous install id is the only identifier;
 *   - `exception.value` is the error *type*, never the raw message
 *     (unless the scrubber allowlisted a static message);
 *   - only the allowlisted scalar fields from {@link ScrubbedErrorEvent}
 *     become tags.
 */
export function buildEnvelope(
  dsn: ParsedSentryDsn,
  ev: ScrubbedErrorEvent,
  meta: EnvelopeMeta,
): BuiltEnvelope {
  const eventId = randomUUID().replace(/-/g, "");
  const timestamp = Date.now() / 1000;

  const tags: Record<string, string> = {
    install_id: meta.installId,
    os: meta.platform,
    error_type: ev.errorType,
    source: ev.source,
  };
  if (ev.category) tags.category = ev.category;
  if (ev.code) tags.code = ev.code;
  if (ev.httpStatus !== undefined) tags.http_status = String(ev.httpStatus);
  if (ev.reason) tags.reason = ev.reason;
  if (ev.tool) tags.tool = ev.tool;
  if (ev.transportHost) tags.transport_host = ev.transportHost;

  const topFrame = ev.frames.at(-1)?.filename ?? "";

  const event = {
    event_id: eventId,
    timestamp,
    platform: "node",
    level: "error",
    release: meta.release,
    // Anonymous id only; `ip_address: null` opts out of IP collection.
    user: { id: meta.installId, ip_address: null },
    tags,
    // The extra discriminator (tool / reason / host) splits a catch-all
    // bucket like "ToolExecutionError: ToolExecutionError" into one issue
    // per failing tool / model-failure reason / transport target, instead
    // of every occurrence landing in a single undiagnosable issue.
    fingerprint: [
      "{{ default }}",
      ev.errorType,
      ev.category ?? "",
      ev.tool ?? ev.reason ?? ev.transportHost ?? "",
      topFrame,
    ],
    exception: {
      values: [
        {
          type: ev.errorType,
          value: ev.message ?? ev.errorType,
          stacktrace: { frames: ev.frames },
        },
      ],
    },
  };

  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn: dsn.dsn,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const payload = JSON.stringify(event);
  const body = `${envelopeHeader}\n${itemHeader}\n${payload}\n`;
  return { eventId, body };
}

/** Build the `X-Sentry-Auth` header value for an envelope POST. */
export function buildSentryAuthHeader(
  dsn: ParsedSentryDsn,
  release: string,
): string {
  return [
    "Sentry sentry_version=7",
    `sentry_client=atomic-agent/${release}`,
    `sentry_key=${dsn.publicKey}`,
  ].join(", ");
}
