import { compareSemver, isNewerVersion, parseSemver } from "./compare-semver.js";

/**
 * Versions the newest release says must not be kept (ATO-1125).
 *
 * The policy travels in the body of the GitHub release the update check
 * already reads (`releases/latest`), as one HTML comment, so it needs no new
 * endpoint and is invisible on the release page:
 *
 *   <!-- atomic-agent-update-policy: {"minimum":"0.6.12","broken":["0.6.10"]} -->
 *
 * - `minimum`: every version below it must update;
 * - `broken`: exact versions with a known breakage that must update.
 *
 * No comment, or one that does not parse, is the empty policy: nothing is
 * required, which is how every release ships until a version is listed.
 * What the app does with a required update (how hard it insists) is decided
 * by the callers, not here.
 */
export interface UpdatePolicy {
  minimum: string | null;
  broken: string[];
}

export type RequiredUpdateReason = "broken" | "below-minimum";

export const EMPTY_UPDATE_POLICY: UpdatePolicy = { minimum: null, broken: [] };

const MARKER = /<!--\s*atomic-agent-update-policy:\s*(\{[\s\S]*?\})\s*-->/;

const clean = (v: string): string => v.trim().replace(/^v/i, "");

export function parseUpdatePolicy(body: string | null | undefined): UpdatePolicy {
  if (!body) return EMPTY_UPDATE_POLICY;
  const m = MARKER.exec(body);
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
    minimum:
      typeof minimum === "string" && parseSemver(minimum) ? clean(minimum) : null,
    broken: Array.isArray(broken)
      ? broken
          .filter((v): v is string => typeof v === "string" && parseSemver(v) !== null)
          .map(clean)
      : [],
  };
}

/**
 * Why `current` must move to `latest`, or `null` when it need not. Never
 * asks for an update that is not one (`latest` not newer), and never sends
 * anyone to a `latest` the same policy lists as broken.
 */
export function requiredUpdateReason(
  current: string,
  latest: string,
  policy: UpdatePolicy,
): RequiredUpdateReason | null {
  if (!isNewerVersion(latest, current)) return null;
  const isListed = (v: string): boolean =>
    policy.broken.some((b) => compareSemver(b, v) === 0 && parseSemver(v) !== null);
  if (isListed(latest)) return null;
  if (isListed(current)) return "broken";
  if (policy.minimum && compareSemver(current, policy.minimum) < 0) return "below-minimum";
  return null;
}

/** One line for a person, or `null`. */
export function requiredUpdateText(reason: RequiredUpdateReason | null): string | null {
  if (reason === "broken") return "this version has a known problem; please update";
  if (reason === "below-minimum") return "this version is no longer supported; please update";
  return null;
}
