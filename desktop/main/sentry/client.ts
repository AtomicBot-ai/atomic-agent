/**
 * Sends scrubbed error events for the desktop shell. Same opt-out as the
 * analytics: nothing is sent while `analytics.enabled` is false or on a test
 * run. Bounded per app session so a crash loop cannot flood the project.
 */

import { currentRunMode, desktopVersion, installChannelFor, installId, sendingAllowed } from "../analytics/index.js";
import { authHeader, buildEnvelope, desktopDsn, parseDsn, type ParsedDsn } from "./envelope.js";
import { safeMessage, safeTag, safeType, sanitizeStack } from "./scrub.js";

const MAX_PER_SESSION = 30;
const MAX_PER_SIGNATURE = 3;

let sent = 0;
const seen = new Map<string, number>();
let parsed: ParsedDsn | null | undefined;

function dsn(): ParsedDsn | null {
  if (parsed === undefined) parsed = parseDsn(desktopDsn());
  return parsed;
}

export interface ErrorInput {
  /** Where it was caught: `uncaughtException`, `renderer`, `render-process-gone`, … */
  source: string;
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  /** Small enum tags (kind, reason, exit_code…); anything not tag-shaped is dropped. */
  tags?: Record<string, unknown>;
  level?: "error" | "warning";
}

export function baseTags(): Record<string, string> {
  const tags: Record<string, string> = {
    surface: "desktop",
    component: "desktop-shell",
    install_channel: installChannelFor(process.platform, process.env),
    platform: process.platform,
    arch: process.arch,
  };
  const v = desktopVersion();
  if (v) tags.desktop_version = v;
  const rm = currentRunMode();
  if (rm) tags.run_mode = rm;
  return tags;
}

/** Fire and forget. Never throws. */
export function reportError(input: ErrorInput): void {
  try {
    if (!sendingAllowed()) return;
    const d = dsn();
    const id = installId();
    if (!d || !id) return;
    const type = safeType(input.name);
    const tags = baseTags();
    const source = safeTag(input.source);
    if (source) tags.source = source;
    for (const [k, v] of Object.entries(input.tags ?? {})) {
      const t = safeTag(v);
      if (t && /^[a-z_]{1,32}$/.test(k)) tags[k] = t;
    }
    const frames = sanitizeStack(input.stack, input.message);
    const signature = `${type}|${tags.source ?? ""}|${tags.kind ?? ""}|${tags.reason ?? ""}|${frames[0]?.filename ?? ""}:${frames[0]?.lineno ?? ""}`;
    const n = seen.get(signature) ?? 0;
    if (sent >= MAX_PER_SESSION || n >= MAX_PER_SIGNATURE) return;
    seen.set(signature, n + 1);
    sent += 1;
    const release = desktopVersion() || "unknown";
    const env = buildEnvelope(d, {
      type,
      message: safeMessage(type, input.message),
      frames,
      release: `atomic-agent-desktop@${release}`,
      sdkVersion: release,
      installId: id,
      tags,
      level: input.level,
    });
    void fetch(d.envelopeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": authHeader(d, release) },
      body: env.body,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  } catch {
    /* an error reporter must never be the error */
  }
}
