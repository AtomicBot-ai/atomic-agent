/**
 * ATO-1467: the "Talk to the team" interview invite (15 min call, $50 in
 * OpenRouter credits after it), desktop side.
 *
 * The rules are the terminal's, `src/analytics/interview-invite.ts`,
 * copied here because the desktop main process cannot import `src/`
 * (same as local-server-url.ts, process-start.ts). Keep the two alike:
 * same file, same limits, same flag, same link.
 *
 *  - never while analytics is off or DO_NOT_TRACK is set (no flag call either);
 *  - never after "Don't ask again" (kept for good);
 *  - not earlier than 7 days after install; at most once per 90 days, 2 times in all;
 *  - never during a turn, first-run setup or an error;
 *  - only when the PostHog flag `interview-invite` is on for the install id.
 *
 * State: `<terminal state dir>/interview-invite.json` (`~/.atomic-agent`),
 * the one file both apps read and write. Pure except the three fs/network
 * helpers at the bottom, which never throw.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { POSTHOG_HOST, POSTHOG_PROJECT_KEY } from "./analytics/transport.js";

export const INTERVIEW_INVITE_FLAG = "interview-invite";
export const INTERVIEW_FORM_URL = "https://tally.so/r/bZjNb6";
export const INTERVIEW_INVITE_FILE = "interview-invite.json";
export const INVITE_MIN_DAYS_AFTER_INSTALL = 7;
export const INVITE_COOLDOWN_DAYS = 90;
export const INVITE_MAX_SHOWS = 2;
export const FLAG_TIMEOUT_MS = 3_000;

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InviteState {
  /** ms epoch of every show, oldest first. */
  shownAt: number[];
  /** ms epoch of "Don't ask again", or null. */
  neverAt: number | null;
}

export interface InviteContext {
  now: number;
  analyticsEnabled: boolean;
  doNotTrack: boolean;
  installId: string | null;
  /** undefined: the install predates its recorded date, so it is old enough. */
  daysSinceInstall: number | undefined;
  busy: boolean;
  onboarding: boolean;
  error: boolean;
  state: InviteState;
}

export type InviteBlock =
  | "analytics_off" | "do_not_track" | "no_install_id" | "never" | "max_shows"
  | "cooldown" | "too_new" | "onboarding" | "busy" | "error";

const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v.trim());

export function parseInviteState(raw: unknown): InviteState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { shownAt: [], neverAt: null };
  const o = raw as Record<string, unknown>;
  const shownAt = Array.isArray(o.shownAt)
    ? o.shownAt.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).sort((a, b) => a - b)
    : [];
  const n = o.neverAt;
  // A refusal is never lost to a corrupt field.
  const neverAt = typeof n === "number" && Number.isFinite(n) ? n : n === null || n === undefined || n === false ? null : 0;
  return { shownAt, neverAt };
}

export function mergeInviteStates(a: InviteState, b: InviteState): InviteState {
  const shownAt = [...new Set([...a.shownAt, ...b.shownAt])].sort((x, y) => x - y);
  const nevers = [a.neverAt, b.neverAt].filter((t): t is number => t !== null);
  return { shownAt, neverAt: nevers.length ? Math.min(...nevers) : null };
}

/** Why the invite may not show now; null = only the flag decides. Privacy first. */
export function inviteBlockedBy(c: InviteContext): InviteBlock | null {
  if (!c.analyticsEnabled) return "analytics_off";
  if (c.doNotTrack) return "do_not_track";
  if (!isId(c.installId)) return "no_install_id";
  if (c.state.neverAt !== null) return "never";
  const shown = c.state.shownAt;
  if (shown.length >= INVITE_MAX_SHOWS) return "max_shows";
  const last = shown.length ? (shown[shown.length - 1] ?? null) : null;
  if (last !== null && c.now - last < INVITE_COOLDOWN_DAYS * DAY_MS) return "cooldown";
  if (c.daysSinceInstall !== undefined && !(c.daysSinceInstall >= INVITE_MIN_DAYS_AFTER_INSTALL)) return "too_new";
  if (c.onboarding) return "onboarding";
  if (c.busy) return "busy";
  if (c.error) return "error";
  return null;
}

/** The form link; `iid` only with analytics on, no DO_NOT_TRACK and a real id. */
export function interviewFormUrl(input: { installId?: string | null; analyticsEnabled: boolean; doNotTrack: boolean }): string {
  const url = new URL(INTERVIEW_FORM_URL);
  const id = input.installId;
  if (input.analyticsEnabled && !input.doNotTrack && isId(id)) url.searchParams.set("iid", id.trim());
  url.searchParams.set("src", "app-desktop");
  return url.toString();
}

/** One flag out of a PostHog `/flags` reply (v2 `flags`, or the older `featureFlags`); anything else is off. */
export function parseFlagReply(body: unknown, key: string): boolean {
  if (body === null || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  const flags = o.flags;
  if (flags && typeof flags === "object") {
    const e = (flags as Record<string, unknown>)[key];
    if (e && typeof e === "object") return (e as { enabled?: unknown }).enabled === true;
  }
  const legacy = o.featureFlags;
  if (legacy && typeof legacy === "object") {
    const v = (legacy as Record<string, unknown>)[key];
    return v === true || (typeof v === "string" && v.length > 0);
  }
  return false;
}

/* ---- fs and network: never throw ---- */

export function readInviteState(stateDir: string): InviteState {
  try {
    return parseInviteState(JSON.parse(readFileSync(join(stateDir, INTERVIEW_INVITE_FILE), "utf8")));
  } catch {
    return { shownAt: [], neverAt: null };
  }
}

/** Merge `patch` into the file as it is now; the written state, or null when it could not be written. */
export function writeInviteState(stateDir: string, patch: InviteState): InviteState | null {
  const next = mergeInviteStates(readInviteState(stateDir), patch);
  const path = join(stateDir, INTERVIEW_INVITE_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return next;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    return null;
  }
}

/** `POST /flags/?v=2` with the public key and the install id only, GeoIP off. Any failure is false. */
export async function fetchInviteFlag(distinctId: string, fetchImpl: typeof fetch = fetch, timeoutMs = FLAG_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetchImpl(`${POSTHOG_HOST}/flags/?v=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: POSTHOG_PROJECT_KEY, distinct_id: distinctId, geoip_disable: true }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    return parseFlagReply(await res.json(), INTERVIEW_INVITE_FLAG);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
