/**
 * ATO-1125: versions the desktop feed says must not be kept.
 *
 * The carrier is the same hidden line the terminal reads from its GitHub
 * release (AtomicBot-ai/atomic-agent#1293), placed in the `releaseNotes` of
 * the desktop feed's update files (`stable-mac.yml`, `stable.yml`,
 * `stable-linux.yml` on the desktop-latest release). electron-updater
 * already hands those notes to the check as `updateInfo.releaseNotes`, so
 * nothing else in the feed changes, and the toast's one notes line skips
 * the comment (firstNotesLine strips tags):
 *
 *   <!-- atomic-agent-update-policy: {"minimum":"0.0.7","broken":["0.0.6"]} -->
 *
 * - `minimum`: every version below it is warned (the chat still starts);
 * - `broken`: exact versions that may not start a new chat until updated.
 *
 * No line, or one that does not parse, is the empty policy: nothing is
 * required. A failed check leaves the policy unread, which is the same.
 */
export interface UpdatePolicy {
  minimum: string | null;
  broken: string[];
}

export type RequiredUpdate = "broken" | "below-minimum";

export const EMPTY_UPDATE_POLICY: UpdatePolicy = { minimum: null, broken: [] };

const MARKER = /<!--\s*atomic-agent-update-policy:\s*(\{[\s\S]*?\})\s*-->/;
const VERSION = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

const clean = (v: string): string => v.trim().replace(/^v/i, "");
const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v.trim());

/** electron-updater's notes are a string, or (multi-release feeds) `{version, note}[]`. */
function notesText(notes: unknown): string {
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes.map((n) => (n && typeof (n as { note?: unknown }).note === "string" ? (n as { note: string }).note : "")).join("\n");
  }
  return "";
}

export function parseUpdatePolicy(notes: unknown): UpdatePolicy {
  const m = MARKER.exec(notesText(notes));
  if (!m?.[1]) return EMPTY_UPDATE_POLICY;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return EMPTY_UPDATE_POLICY;
  }
  if (!raw || typeof raw !== "object") return EMPTY_UPDATE_POLICY;
  const { minimum, broken } = raw as { minimum?: unknown; broken?: unknown };
  return {
    minimum: isVersion(minimum) ? clean(minimum) : null,
    broken: Array.isArray(broken) ? broken.filter(isVersion).map(clean) : [],
  };
}

/**
 * Why `current` must move to `latest`, or null. Never for a `latest` that is
 * not newer, and never to a `latest` the same policy lists as broken.
 */
export function requiredUpdate(
  current: string,
  latest: string,
  policy: UpdatePolicy,
  compare: (a: string, b: string) => number,
): RequiredUpdate | null {
  if (compare(latest, current) <= 0) return null;
  const listed = (v: string): boolean => policy.broken.some((b) => compare(b, v) === 0);
  if (listed(latest)) return null;
  if (listed(current)) return "broken";
  if (policy.minimum && compare(current, policy.minimum) < 0) return "below-minimum";
  return null;
}
