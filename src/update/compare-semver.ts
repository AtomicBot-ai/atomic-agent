interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse an `X.Y.Z` semver, tolerating a leading `v` and an optional
 * pre-release / build suffix (`1.2.3-rc.1`, `1.2.3+meta`). Returns
 * `null` for anything that does not start with three numeric segments.
 * Pre-release / build metadata is intentionally ignored — the update
 * check only compares the numeric core.
 */
export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const core = cleaned.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const [major, minor, patch] = parts.map((p) => Number.parseInt(p, 10));
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Compare two semver strings. Returns `1` when `a > b`, `-1` when
 * `a < b`, `0` when equal or when either side is unparseable (treating
 * unparseable inputs as equal avoids spurious update prompts).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) === 1;
}
