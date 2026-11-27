/**
 * ATO-2510: reads `atag login chatgpt --json` (src/cli/login-chatgpt-output.ts
 * in the agent), one JSON object per line with a `type`, so the wizard no
 * longer depends on the agent's English sentences. Only three lines matter
 * here: the sign-in link, signed in (with the provider entry id) and the
 * error reason. Every other line, a broken line or an unknown type is
 * skipped. Nothing read here is logged or kept after the sign-in.
 */

export type ChatgptOauthReason = "timeout" | "no_account" | "cancelled" | "failed";

export type LoginJsonEvent =
  /** `url` is null when the link is not exactly https://auth.openai.com/oauth/authorize. */
  | { type: "authorization_url"; url: string | null }
  | { type: "signed_in"; providerId?: string }
  | { type: "error"; reason: ChatgptOauthReason };

const REASONS: ReadonlySet<string> = new Set(["timeout", "no_account", "cancelled", "failed"]);
const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** A single line longer than this is dropped, never kept growing. */
const MAX_LINE = 64 * 1024;

/** The sign-in link, only when it is an https link to exactly auth.openai.com/oauth/authorize. */
export function checkedAuthorizationUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.port !== "" || url.username || url.password) return null;
    if (url.pathname !== "/oauth/authorize") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** One line of `--json` output, or null when it is not one this module uses. */
export function parseLoginJsonLine(line: string): LoginJsonEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  switch (e.type) {
    case "authorization_url":
      return { type: "authorization_url", url: typeof e.url === "string" ? checkedAuthorizationUrl(e.url) : null };
    case "signed_in":
      return typeof e.providerId === "string" && PROVIDER_ID.test(e.providerId)
        ? { type: "signed_in", providerId: e.providerId }
        : { type: "signed_in" };
    case "error":
      return { type: "error", reason: typeof e.reason === "string" && REASONS.has(e.reason) ? (e.reason as ChatgptOauthReason) : "failed" };
    default:
      return null;
  }
}

/** Splits stdout chunks into whole lines (a chunk can end mid-line) and parses each. */
export function createLoginJsonReader(): { push(chunk: string): LoginJsonEvent[] } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > MAX_LINE) pending = "";
      const events: LoginJsonEvent[] = [];
      for (const line of lines) {
        const event = line.trim() ? parseLoginJsonLine(line.trim()) : null;
        if (event) events.push(event);
      }
      return events;
    },
  };
}

/** `atag login --help` lists `--json` on the `login chatgpt` usage line (agents with ATO-2510). */
export function helpHasLoginJson(output: string): boolean {
  return /\blogin chatgpt\b[^\n]*--json/.test(output);
}
