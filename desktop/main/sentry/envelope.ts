/**
 * The DSN and a hand-built Sentry envelope, mirroring
 * `src/error-reporting/sentry-config.ts` and `sentry-envelope.ts` (the
 * desktop build cannot import from `src/`).
 *
 * DSN: `ATOMIC_DESKTOP_SENTRY_DSN` when set, else the agent's DSN (copied
 * from src/error-reporting/sentry-config.ts) with tag `component:
 * desktop-shell`. A dedicated desktop project is one constant away.
 */

import { randomUUID } from "node:crypto";

import type { StackFrame } from "./scrub.js";

export const AGENT_SENTRY_DSN =
  "https://a8fd56d7868a50e55650ccf704a5fdf3@o4511710615699456.ingest.us.sentry.io/4511727478636544";
const PLACEHOLDER = "PLACEHOLDER";

export interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
  envelopeUrl: string;
  dsn: string;
}

export function desktopDsn(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.ATOMIC_DESKTOP_SENTRY_DSN;
  return typeof own === "string" && own.trim() ? own.trim() : AGENT_SENTRY_DSN;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  if (!dsn || dsn === PLACEHOLDER) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  const path = url.pathname.replace(/\/+$/, "");
  const projectId = path.slice(path.lastIndexOf("/") + 1);
  if (!publicKey || !projectId) return null;
  const basePath = path.slice(0, path.lastIndexOf("/"));
  const origin = `${url.protocol}//${url.host}${basePath}`;
  return {
    publicKey,
    host: url.host,
    projectId,
    envelopeUrl: `${origin}/api/${projectId}/envelope/`,
    dsn,
  };
}

export interface EnvelopeEvent {
  type: string;
  message?: string;
  frames: StackFrame[];
  release: string;
  /** The desktop version for the `sdk` block (`unknown` outside a packaged app). */
  sdkVersion: string;
  installId: string;
  tags: Record<string, string>;
  /** `error` for exceptions, `warning` for a crash/exit seen only as tags. */
  level?: "error" | "warning";
}

export function buildEnvelope(dsn: ParsedDsn, ev: EnvelopeEvent): { eventId: string; body: string } {
  const eventId = randomUUID().replace(/-/g, "");
  const top = ev.frames[0]?.filename ?? "";
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    // Always `node`, renderer errors included: Sentry infers the client IP for
    // `javascript` events unless told not to, and the sdk block below says so too.
    platform: "node",
    sdk: { name: "atomic-agent-desktop", version: ev.sdkVersion, settings: { infer_ip: "never" } },
    level: ev.level ?? "error",
    release: ev.release,
    user: { id: ev.installId, ip_address: null },
    tags: ev.tags,
    fingerprint: ["{{ default }}", ev.type, ev.tags.source ?? "", ev.tags.kind ?? "", ev.tags.reason ?? "", top],
    exception: {
      values: [
        {
          type: ev.type,
          value: ev.message ?? ev.type,
          // Sentry wants the oldest frame first; V8 lists the throw site first.
          stacktrace: {
            frames: ev.frames.map((f) => ({ ...f, in_app: !f.filename.startsWith("node:") })).reverse(),
          },
        },
      ],
    },
  };
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.dsn });
  return { eventId, body: `${header}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n` };
}

export function authHeader(dsn: ParsedDsn, release: string): string {
  return ["Sentry sentry_version=7", `sentry_client=atomic-agent-desktop/${release}`, `sentry_key=${dsn.publicKey}`].join(", ");
}
