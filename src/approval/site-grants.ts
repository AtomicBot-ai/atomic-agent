/**
 * Per-site session grants for the browser (ATO-1181).
 *
 * "Allow in this chat" on a form submit at site A used to grant the
 * whole `browser_commit` category, so every later submit, delete or
 * post on any other site ran unasked, including one a prompt-injected
 * page steered the agent to. For the two browser categories whose
 * requests name the site they act on (`affectedResources: [host]`),
 * a session grant now covers that one host only: a grant on
 * `example.com` does not cover `mail.example.com`, `example.org` or
 * any other host, and those ask again.
 *
 * Hosts match exactly (case and trailing dots aside), so a subdomain is
 * a separate site. A request of these categories that names no single
 * host cannot be granted for the session at all: it asks every time.
 * `browser_secret` (passwords, payments) stays never-grantable.
 */
import type { ApprovalCategory } from "./approval-level.js";

/** Categories whose session grant is per site rather than per category. */
const SITE_SCOPED: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>([
  "browser_commit",
  "browser_offsite",
]);

export function isSiteScopedCategory(category: ApprovalCategory): boolean {
  return SITE_SCOPED.has(category);
}

/** The shape of a request this module reads. */
export interface SiteScopedRequest {
  category: ApprovalCategory;
  affectedResources?: readonly string[];
}

/**
 * The host a session grant for `request` would cover, or `null` when the
 * category is not site-scoped or the request does not name exactly one
 * host. Lower-cased, trailing dots removed, like the browser's own host
 * normalisation (`browser-domain-policy.ts`).
 */
export function siteGrantHost(request: SiteScopedRequest): string | null {
  if (!isSiteScopedCategory(request.category)) return null;
  const resources = request.affectedResources ?? [];
  if (resources.length !== 1) return null;
  const host = (resources[0] ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (host.length === 0 || /[\s/]/.test(host)) return null;
  return host;
}

/** Key of one per-site grant in a session's grant set. */
export function siteGrantKey(category: ApprovalCategory, host: string): string {
  return `${category} ${host}`;
}

/** One live per-site grant, for diagnostics and the privacy panel. */
export interface SiteGrant {
  category: ApprovalCategory;
  host: string;
}

export function parseSiteGrantKey(key: string): SiteGrant {
  const space = key.indexOf(" ");
  return {
    category: key.slice(0, space) as ApprovalCategory,
    host: key.slice(space + 1),
  };
}
