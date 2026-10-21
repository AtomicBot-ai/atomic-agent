import type { SessionState } from "./session-state.js";
import {
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_USER_SET_AT_KEY,
} from "./session-title.js";

/*
 * A title the operator typed carries `SESSION_TITLE_USER_SET_AT_KEY`
 * beside it: the epoch ms of the rename. Its presence is what makes a
 * title the operator's: the namer never touches a titled session, the
 * store never lets a copy without the stamp (or with an older one) write
 * over it, and the reasoning cleanup in `readSessionTitle` leaves the
 * text exactly as typed.
 */

/**
 * Upper bound for a title the operator types. Wider than the generated
 * `SESSION_TITLE_MAX_CHARS`: a person who spells out a longer name means
 * it, and the lists ellipsize what does not fit.
 */
export const SESSION_USER_TITLE_MAX_CHARS = 120;

export type UserSessionTitleResult =
  | { ok: true; title: string }
  | { ok: false; error: string };

/**
 * Validate a title the operator typed: a string, trimmed, 1 to
 * `SESSION_USER_TITLE_MAX_CHARS` characters, on one line. Refused rather
 * than repaired: the rename box shows what was sent, and a name silently
 * cut or joined would not be the one the operator saw.
 */
export function validateUserSessionTitle(raw: unknown): UserSessionTitleResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  const title = raw.trim();
  if (title.length === 0) {
    return { ok: false, error: "title must not be empty" };
  }
  if (/[\r\n\u2028\u2029]/u.test(title)) {
    return { ok: false, error: "title must be a single line" };
  }
  if ([...title].length > SESSION_USER_TITLE_MAX_CHARS) {
    return {
      ok: false,
      error: `title must be at most ${SESSION_USER_TITLE_MAX_CHARS} characters`,
    };
  }
  return { ok: true, title };
}

/** The rename stamp, or `null` when no operator named this session. */
export function readUserTitleSetAt(
  metadata: Record<string, unknown> | undefined,
): number | null {
  const raw = metadata?.[SESSION_TITLE_USER_SET_AT_KEY];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** `state` carrying the operator's `title`, stamped at `now`. */
export function withUserSessionTitle(
  state: SessionState,
  title: string,
  now: number = Date.now(),
): SessionState {
  return {
    ...state,
    metadata: {
      ...state.metadata,
      [SESSION_TITLE_METADATA_KEY]: title,
      [SESSION_TITLE_USER_SET_AT_KEY]: now,
    },
  };
}
