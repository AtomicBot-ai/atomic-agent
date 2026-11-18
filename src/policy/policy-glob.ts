/**
 * Glob matching for policy resources, the OpenWork / OpenCode permission
 * wildcard: `*` is any run of characters (a `/` too, so `rm *` covers
 * `rm -rf /tmp/x` and `https://*.example.com/*` covers any path), `?` is
 * one character, everything else is literal. The whole string must match.
 */

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

export function globMatches(pattern: string, value: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = compile(pattern);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re.test(value);
}
