/**
 * Where `os.web.crawl` may follow its start page when it redirects (ATO-970).
 *
 * The crawl stays on one site. A start page that moves within the same site
 * (http to https, `example.com` to `www.example.com`, `example.com` to
 * `docs.example.com`) moves the crawl with it: the new host becomes the
 * scope, with its own robots.txt. A start page that moves to another site
 * stops the crawl, and the result says where it went.
 *
 * "Same site" is the registrable domain (eTLD+1), as in Crawlee's
 * `same-domain` enqueue strategy. The agent ships no public-suffix list, so
 * this is an approximation: two-letter country codes with a generic second
 * level (`co.uk`, `com.au`, `co.jp`) count as one suffix, and a short list
 * of shared hosting domains (`github.io`, `vercel.app`, ...) count as public
 * suffixes, so two users' sites there are never one site.
 */
import { isIP } from "node:net";

/** Shared hosting where every subdomain belongs to someone else (PSL private section, abridged). */
const SHARED_HOSTING_SUFFIXES = [
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "replit.app",
  "blogspot.com",
  "wordpress.com",
  "substack.com",
  "notion.site",
  "webflow.io",
  "wixsite.com",
  "myshopify.com",
  "readthedocs.io",
  "gitbook.io",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "appspot.com",
];

const GENERIC_SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|gob|mil|nic|ltd|plc|sch|info|biz)$/;

function cleanHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** The registrable domain of `hostname`, or null for an IP address or a bare suffix. */
export function registrableDomain(hostname: string): string | null {
  const host = cleanHost(hostname);
  if (isIP(host) !== 0) return null;
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;
  for (const suffix of SHARED_HOSTING_SUFFIXES) {
    if (host === suffix) return null;
    if (host.endsWith(`.${suffix}`)) {
      const owner = host.slice(0, -suffix.length - 1).split(".").pop();
      return owner ? `${owner}.${suffix}` : null;
    }
  }
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  if (tld.length === 2 && GENERIC_SECOND_LEVEL.test(second)) {
    return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  }
  return labels.slice(-2).join(".");
}

function withoutWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

export type StartMove = { ok: true } | { ok: false; reason: string };

/** May the crawl follow its start page from `from` to `to`? */
export function startMoveAllowed(from: URL, to: URL): StartMove {
  const a = cleanHost(from.hostname);
  const b = cleanHost(to.hostname);
  if (a === b) return { ok: true };
  if (withoutWww(a) === withoutWww(b)) return { ok: true };
  const siteA = registrableDomain(a);
  if (siteA !== null && siteA === registrableDomain(b)) return { ok: true };
  return { ok: false, reason: `it redirects to ${to.host}, which is another site` };
}
