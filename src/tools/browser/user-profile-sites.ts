import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import { hostMatchesAny, type BrowserDomainPolicy } from "./browser-domain-policy.js";

/**
 * Sites the user let the agent open in their own Chrome, per session
 * (`browser.connect: "user-chrome"`, ATO-511). There the browser carries
 * the user's signed-in sessions, so opening a site and reading it is
 * reading their account (mail, a cloud console), and a URL the agent
 * opens can carry what it read to someone else. Each new site asks once
 * per session; hosts in `browser.allowedDomains` do not ask.
 */
export class UserSiteApprovals {
  private readonly bySession = new Map<string, Set<string>>();

  has(sessionId: string, host: string): boolean {
    return this.bySession.get(sessionId)?.has(host) ?? false;
  }

  add(sessionId: string, host: string): void {
    const hosts = this.bySession.get(sessionId) ?? new Set<string>();
    hosts.add(host);
    this.bySession.set(sessionId, hosts);
  }
}

/** The host may be opened / read without asking (or this is not the user's Chrome). */
export function userSiteCleared(
  policy: BrowserDomainPolicy,
  host: string | null,
  sessionId: string,
): boolean {
  if (!policy.userProfile || host === null) return true;
  if (hostMatchesAny(host, policy.allowedDomains)) return true;
  return policy.userSites?.has(sessionId, host) ?? false;
}

/**
 * Ask before opening or reading `host` in the user's own Chrome, once per
 * session. `browser_secret`: asks at every level below full trust and is
 * never covered by a session grant, so one "allow" never stands for the
 * next site. Throws `ApprovalDeniedError` on a no.
 */
export async function requireUserSite(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  host: string | null,
  preview: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<void> {
  if (host === null || userSiteCleared(policy, host, ctx.sessionId)) return;
  await requireApproval(
    dangerous,
    {
      sessionId: ctx.sessionId,
      tool,
      category: "browser_secret",
      reason: `open and read ${host} in your own Chrome, where you may be signed in`,
      preview,
      affectedResources: [host],
    },
    ctx.signal,
  );
  policy.userSites?.add(ctx.sessionId, host);
}
