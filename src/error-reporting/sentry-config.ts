/**
 * Hardcoded Sentry DSN. A Sentry DSN embeds a *public* ingestion key
 * (safe to ship in client code — it can only write events, never read
 * them), so it lives inline rather than in `.env` / user config, exactly
 * like the PostHog project key.
 *
 * While the value equals {@link SENTRY_PLACEHOLDER_DSN}, the client
 * short-circuits and never opens a connection — this lets a build ship
 * with error reporting stubbed out until a real DSN is filled in.
 */
export const SENTRY_DSN: string = "https://a8fd56d7868a50e55650ccf704a5fdf3@o4511710615699456.ingest.us.sentry.io/4511727478636544";

/** Sentinel that disables error reporting when used as the DSN. */
export const SENTRY_PLACEHOLDER_DSN = "PLACEHOLDER";

/** Parsed pieces of a Sentry DSN needed to POST an envelope. */
export interface ParsedSentryDsn {
  /** Public ingestion key (the DSN userinfo component). */
  publicKey: string;
  /** Host[:port] the ingest endpoint lives on. */
  host: string;
  /** Numeric project id (last path segment). */
  projectId: string;
  /** Fully-resolved `/api/<projectId>/envelope/` URL. */
  envelopeUrl: string;
  /** The original DSN string (echoed back in the envelope header). */
  dsn: string;
}

/**
 * Parse a Sentry DSN of the form
 * `<scheme>://<publicKey>@<host>[:port]/[<path>/]<projectId>` into the
 * pieces required to build an ingest envelope URL. Returns `null` for any
 * malformed DSN — callers treat a `null` as "error reporting disabled".
 */
export function parseSentryDsn(dsn: string): ParsedSentryDsn | null {
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
  const envelopeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/`;
  return { publicKey, host: url.host, projectId, envelopeUrl, dsn };
}
