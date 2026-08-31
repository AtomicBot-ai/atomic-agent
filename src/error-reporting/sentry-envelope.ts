import { randomUUID } from "node:crypto";

import type { ParsedSentryDsn } from "./sentry-config.js";
import type {
  ScrubbedErrorEvent,
  SentryStackFrame,
} from "./error-scrubber.js";

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
  if (ev.causeType) tags.cause_type = ev.causeType;
  if (ev.category) tags.category = ev.category;
  if (ev.code) tags.code = ev.code;
  if (ev.httpStatus !== undefined) tags.http_status = String(ev.httpStatus);
  if (ev.reason) tags.reason = ev.reason;
  if (ev.tool) tags.tool = ev.tool;
  if (ev.transportHost) tags.transport_host = ev.transportHost;

  // `frames[0]` is the innermost frame (V8 lists the throw site first),
  // i.e. where the failure actually originated. `.at(-1)` would instead
  // pick the outermost caller (e.g. the TUI's turn entry point), which is
  // shared by unrelated bugs and defeats the fingerprint's purpose.
  const topFrame = ev.frames[0]?.filename ?? "";

  const event = {
    event_id: eventId,
    timestamp,
    platform: "node",
    level: "error",
    release: meta.release,
    // Anonymous id only; `ip_address: null` opts out of IP collection.
    user: { id: meta.installId, ip_address: null },
    tags,
    // The extra discriminator (causeType / tool / reason / host) splits a
    // catch-all bucket like "ToolExecutionError: ToolExecutionError" into
    // one issue per underlying cause class / failing tool / model-failure
    // reason / transport target, instead of every occurrence landing in a
    // single undiagnosable issue. `causeType` is checked first because it
    // is only ever populated on the generic-wrapper path (see
    // `toLlmFailure`'s catch-all) where `tool` is always the useless
    // literal `"unknown"`.
    fingerprint: [
      "{{ default }}",
      ev.errorType,
      ev.category ?? "",
      ev.causeType ?? ev.tool ?? ev.reason ?? ev.transportHost ?? "",
      topFrame,
    ],
    exception: {
      values: [
        {
          type: ev.errorType,
          value: ev.message ?? ev.errorType,
          // `ev.frames` stays innermost-first for the fingerprint above;
          // the wire format wants the opposite. See `toSentryFrameOrder`.
          stacktrace: { frames: toSentryFrameOrder(ev.frames) },
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

/** A stack frame as Sentry's ingest protocol wants it. */
interface WireStackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/**
 * Reorder and annotate frames for the wire.
 *
 * Two protocol details, both of which we were getting wrong:
 *
 *  - **Order.** Sentry lists a stack oldest frame FIRST, so the crash
 *    site is the LAST entry — the opposite of V8, which puts the throw
 *    site at index 0. Sending V8 order rendered every stack upside-down
 *    in the UI and, worse, made Sentry read the culprit off the wrong
 *    end: that is why the issue list is a wall of `async run`,
 *    `async executeStep`, `async runOneTurn` — the outermost caller of
 *    unrelated bugs — instead of the frame that actually threw.
 *
 *  - **`in_app`.** Nothing ever set it, so every frame was a system
 *    frame (`in_app_frame_mix: "system-only"` on all of our issues) and
 *    Sentry's culprit/grouping heuristics had nothing of ours to
 *    prefer. Anything that is not a `node:` internal is ours — the
 *    scrubber has already reduced paths to basenames, and the bundle
 *    is a single file, so there is no dependency directory left to
 *    distinguish.
 *
 * `ev.frames` is left untouched (a copy is reversed): the fingerprint
 * reads `frames[0]` as the innermost frame, and flipping that would
 * re-group every existing issue.
 */
function toSentryFrameOrder(frames: SentryStackFrame[]): WireStackFrame[] {
  return frames
    .map((frame) => ({
      ...frame,
      in_app: !frame.filename.startsWith("node:"),
    }))
    .reverse();
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
