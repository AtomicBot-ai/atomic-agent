import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import {
  blockedHostOfPage,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { requireUserSite, userSiteCleared } from "./user-profile-sites.js";

export type PageReadVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; host: string }
  | { kind: "user_site_not_cleared"; host: string | null };

/** Ask for an uncleared site in the user's own Chrome instead of refusing it. */
export interface PageReadAsk {
  dangerous: DangerousToolOptions;
  tool: string;
  signal: AbortSignal;
}

/**
 * The one check before page content reaches the model: every snapshot
 * view (`read_aria`, the world snapshot after navigate / search) and
 * every screenshot goes through it.
 *
 * - The page, or any frame it embeds, on a blocked host: `blocked`.
 * - The user's own Chrome (`policy.userProfile`): a site not cleared
 *   this session asks once with `ask` (`user-profile-sites.ts`; a "no"
 *   throws `ApprovalDeniedError`); without `ask`, or without a session,
 *   it is `user_site_not_cleared`.
 */
export async function gatePageRead(
  page: { url: string; frameUrls?: readonly string[] },
  policy: BrowserDomainPolicy,
  sessionId: string | undefined,
  ask?: PageReadAsk,
): Promise<PageReadVerdict> {
  const blocked = blockedHostOfPage(page.url, page.frameUrls, policy);
  if (blocked !== null) return { kind: "blocked", host: blocked };
  if (!policy.userProfile) return { kind: "ok" };
  const host = webHostOf(page.url);
  if (sessionId !== undefined && userSiteCleared(policy, host, sessionId)) return { kind: "ok" };
  if (ask && sessionId !== undefined) {
    await requireUserSite(ask.dangerous, policy, ask.tool, host, `read ${page.url}`, {
      sessionId,
      signal: ask.signal,
    });
    return { kind: "ok" };
  }
  return { kind: "user_site_not_cleared", host };
}
