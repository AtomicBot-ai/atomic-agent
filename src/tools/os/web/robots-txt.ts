/**
 * robots.txt parsing and matching (RFC 9309), for `os.web.crawl` (ATO-970).
 *
 * Only what a polite crawler needs: the group that applies to us, its
 * Allow/Disallow rules with `*` and `$` wildcards, the non-standard but
 * widely used `Crawl-delay`, and the `Sitemap` lines. Matching follows the
 * RFC: the longest matching pattern wins and, on a tie, Allow wins.
 */

/** Product tokens a site may address us by. Matched case-insensitively. */
export const ROBOTS_PRODUCT_TOKENS: readonly string[] = ["atomic-agent", "atomicagent"];

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: readonly RobotsRule[];
  /** Seconds from `Crawl-delay` in the applying group, when present. */
  crawlDelaySeconds: number | null;
  /** Absolute sitemap URLs listed anywhere in the file. */
  sitemaps: readonly string[];
}

/** Everything allowed, nothing listed: a missing or empty robots.txt. */
export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: null, sitemaps: [] };

/** Nothing allowed: robots.txt could not be read because the server failed (RFC 9309 2.3.1.4). */
export const DISALLOW_ALL: RobotsPolicy = {
  rules: [{ allow: false, pattern: "/" }],
  crawlDelaySeconds: null,
  sitemaps: [],
};

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

/** RFC 9309 asks crawlers to read at least 500 KiB; anything after is ignored. */
const MAX_ROBOTS_BYTES = 512 * 1024;

export function parseRobotsTxt(
  text: string,
  tokens: readonly string[] = ROBOTS_PRODUCT_TOKENS,
): RobotsPolicy {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  // A run of user-agent lines opens one group; the first rule closes the run.
  let collectingAgents = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap") {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (current === null) continue; // Rules before any user-agent apply to no one.
    collectingAgents = false;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "nothing disallowed": no rule at all.
      if (value.length > 0) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }

  const wanted = tokens.map((t) => t.toLowerCase());
  const specific = groups.filter((g) => g.agents.some((a) => wanted.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  const delays = chosen
    .map((g) => g.crawlDelaySeconds)
    .filter((d): d is number => d !== null);
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
    sitemaps,
  };
}

/** Is `url` (path and query) allowed under `policy`? */
export function isAllowedByRobots(policy: RobotsPolicy, url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  // robots.txt itself is always allowed (RFC 9309 2.2.2).
  if (url.pathname === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, target)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null || best.allow;
}

const compiled = new Map<string, RegExp>();

/** `*` matches any run of characters, a trailing `$` anchors the end; otherwise a prefix match. */
export function patternMatches(pattern: string, target: string): boolean {
  let re = compiled.get(pattern);
  if (re === undefined) {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split("*")
      .map((part) => normalisePercent(part).replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${source}${anchored ? "$" : ""}`);
    if (compiled.size > 2_000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re.test(normalisePercent(target));
}

/** Compare `%7E` and `~` alike: upper-case escapes, decode unreserved characters. */
function normalisePercent(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}
