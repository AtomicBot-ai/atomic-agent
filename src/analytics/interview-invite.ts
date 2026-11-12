/**
 * "Talk to the team" interview invite (ATO-1467): a 15 minute call with
 * the team, $50 in OpenRouter credits after it.
 *
 * This file holds every rule about WHEN the rare invite may show, as pure
 * functions over plain values, so the terminal and the desktop decide the
 * same way and the limits are unit-tested in one place:
 *
 *  - never while analytics is off or `DO_NOT_TRACK` is set (and then no
 *    flag call either);
 *  - never after "don't ask again" (stored for good);
 *  - not earlier than 7 days after install;
 *  - at most once per 90 days, at most 2 times in total;
 *  - never during an agent turn, first-run setup, or an error;
 *  - only when the PostHog flag `interview-invite` is on for this
 *    install id (Nadya picks the group in PostHog, no release needed).
 *
 * The permanent entry (Help menu, `/feedback`) has no limits; it only
 * drops the install id from the form link when analytics is off.
 *
 * The state lives in `<stateDir>/interview-invite.json`, the folder the
 * terminal and the desktop share (`~/.atomic-agent`). The desktop main
 * process cannot import `src/`, so `desktop/main/interview-invite.ts`
 * copies these rules; keep the two alike.
 */

/** PostHog feature flag that opens the rare invite for a group of installs. */
export const INTERVIEW_INVITE_FLAG = "interview-invite";

/** The interview sign-up form. */
export const INTERVIEW_FORM_URL = "https://tally.so/r/bZjNb6";

/** State file name, inside the shared state dir. */
export const INTERVIEW_INVITE_FILE = "interview-invite.json";

export const INVITE_MIN_DAYS_AFTER_INSTALL = 7;
export const INVITE_COOLDOWN_DAYS = 90;
export const INVITE_MAX_SHOWS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostHog event names. */
export const INTERVIEW_INVITE_EVENTS = {
  shown: "interview_invite_shown",
  clicked: "interview_invite_clicked",
  dismissed: "interview_invite_dismissed",
} as const;

export type InterviewInviteEventKind = keyof typeof INTERVIEW_INVITE_EVENTS;

/** Where a click came from. */
export type InterviewInviteVia = "menu" | "card" | "banner" | "slash";

/** Why the invite was put away: for now, or for good. */
export type InterviewInviteDismissReason = "later" | "never";

/** `src=` in the form link. */
export type InterviewInviteSource = "app-desktop" | "app-terminal";

/** The one quiet line the terminal shows at session start. */
export const TERMINAL_INVITE_LINE =
  "Got 15 min? Tell us what broke and get $50 in OpenRouter credits → /feedback  (hide: /feedback never)";

export interface InterviewInviteState {
  /** ms epoch of every time the rare invite was shown, oldest first. */
  shownAt: number[];
  /** ms epoch of "don't ask again"; null while it was never pressed. */
  neverAt: number | null;
}

export function emptyInterviewInviteState(): InterviewInviteState {
  return { shownAt: [], neverAt: null };
}

/**
 * Read the state file's JSON. Anything malformed reads as "nothing yet",
 * except that a `neverAt` that is there in any truthy form counts: a
 * refusal must not be lost to a corrupt field.
 */
export function parseInterviewInviteState(raw: unknown): InterviewInviteState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyInterviewInviteState();
  }
  const obj = raw as Record<string, unknown>;
  const shownAt = Array.isArray(obj.shownAt)
    ? obj.shownAt
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      .sort((a, b) => a - b)
    : [];
  const never = obj.neverAt;
  const neverAt =
    typeof never === "number" && Number.isFinite(never)
      ? never
      : never === null || never === undefined || never === false
        ? null
        : 0;
  return { shownAt, neverAt };
}

/**
 * Fold two copies of the state (the file now, and this process's view)
 * into one: every show is kept once, and a refusal on either side wins.
 * The terminal and the desktop may both write the file.
 */
export function mergeInterviewInviteStates(
  a: InterviewInviteState,
  b: InterviewInviteState,
): InterviewInviteState {
  const shownAt = [...new Set([...a.shownAt, ...b.shownAt])].sort((x, y) => x - y);
  const nevers = [a.neverAt, b.neverAt].filter((t): t is number => t !== null);
  return { shownAt, neverAt: nevers.length ? Math.min(...nevers) : null };
}

export function recordInviteShown(
  state: InterviewInviteState,
  now: number,
): InterviewInviteState {
  return mergeInterviewInviteStates(state, { shownAt: [now], neverAt: null });
}

export function recordInviteNever(
  state: InterviewInviteState,
  now: number,
): InterviewInviteState {
  return mergeInterviewInviteStates(state, { shownAt: [], neverAt: now });
}

/** Everything the rule needs, as plain values. */
export interface InterviewInviteContext {
  now: number;
  /** `analytics.enabled` (and not forced off by `ATOMIC_AGENT_ANALYTICS=off`). */
  analyticsEnabled: boolean;
  /** `DO_NOT_TRACK=1` in the environment. */
  doNotTrack: boolean;
  /** The anonymous shared install id; null while there is none. */
  installId: string | null;
  /**
   * Whole days since install. `undefined` = the install predates the
   * install date being recorded, so it is older than any recorded one
   * and counts as old enough.
   */
  daysSinceInstall: number | undefined;
  /** An agent turn is running. */
  busy: boolean;
  /** First-run setup is open or still due. */
  onboarding: boolean;
  /** An error is on screen (or happened this launch, before the invite). */
  error: boolean;
  state: InterviewInviteState;
}

export type InterviewInviteBlock =
  | "analytics_off"
  | "do_not_track"
  | "no_install_id"
  | "never"
  | "max_shows"
  | "cooldown"
  | "too_new"
  | "onboarding"
  | "busy"
  | "error";

/**
 * Why the rare invite may not show right now, or null when nothing but
 * the feature flag stands in the way. Privacy comes first: while it
 * returns `analytics_off` / `do_not_track` the flag must not be asked.
 */
export function interviewInviteBlockedBy(
  ctx: InterviewInviteContext,
): InterviewInviteBlock | null {
  if (!ctx.analyticsEnabled) return "analytics_off";
  if (ctx.doNotTrack) return "do_not_track";
  if (!isInstallId(ctx.installId)) return "no_install_id";
  if (ctx.state.neverAt !== null) return "never";
  const shown = ctx.state.shownAt;
  if (shown.length >= INVITE_MAX_SHOWS) return "max_shows";
  const last = shown.length ? (shown[shown.length - 1] ?? null) : null;
  // A show "in the future" (the clock went back) still counts as recent.
  if (last !== null && ctx.now - last < INVITE_COOLDOWN_DAYS * DAY_MS) {
    return "cooldown";
  }
  if (
    ctx.daysSinceInstall !== undefined &&
    !(ctx.daysSinceInstall >= INVITE_MIN_DAYS_AFTER_INSTALL)
  ) {
    return "too_new";
  }
  if (ctx.onboarding) return "onboarding";
  if (ctx.busy) return "busy";
  if (ctx.error) return "error";
  return null;
}

/** True when the rare invite should show: nothing blocks it and the flag is on. */
export function shouldShowInterviewInvite(
  ctx: InterviewInviteContext,
  flagEnabled: boolean,
): boolean {
  return flagEnabled === true && interviewInviteBlockedBy(ctx) === null;
}

/** Whether the form link may carry the install id: analytics on, no DNT, a real id. */
export function mayShareInstallId(input: {
  analyticsEnabled: boolean;
  doNotTrack: boolean;
  installId?: string | null;
}): boolean {
  return input.analyticsEnabled && !input.doNotTrack && isInstallId(input.installId);
}

/**
 * The form link. `iid` is the anonymous install id, only when
 * `mayShareInstallId` allows it; nothing else about the user goes in.
 */
export function buildInterviewFormUrl(input: {
  source: InterviewInviteSource;
  installId?: string | null;
  analyticsEnabled: boolean;
  doNotTrack: boolean;
}): string {
  const url = new URL(INTERVIEW_FORM_URL);
  const id = input.installId;
  if (mayShareInstallId(input) && typeof id === "string") url.searchParams.set("iid", id.trim());
  url.searchParams.set("src", input.source);
  return url.toString();
}

/**
 * Read one flag out of a PostHog `/flags` reply: the v2 shape
 * (`flags: { key: { enabled } }`) or the older one
 * (`featureFlags: { key: true | "variant" }`). Anything else is off.
 */
export function parseFeatureFlagReply(body: unknown, key: string): boolean {
  if (body === null || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const flags = obj.flags;
  if (flags && typeof flags === "object") {
    const entry = (flags as Record<string, unknown>)[key];
    if (entry && typeof entry === "object") {
      return (entry as { enabled?: unknown }).enabled === true;
    }
  }
  const legacy = obj.featureFlags;
  if (legacy && typeof legacy === "object") {
    const value = (legacy as Record<string, unknown>)[key];
    return value === true || (typeof value === "string" && value.length > 0);
  }
  return false;
}

function isInstallId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}
