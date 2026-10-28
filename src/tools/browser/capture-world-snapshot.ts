import type { BrowserBackend } from "./browser-backend.js";
import { userSiteCleared } from "./user-profile-sites.js";
import {
  blockedHostOfPage,
  EMPTY_DOMAIN_POLICY,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";

export interface CapturedWorldSnapshot {
  kind: "browser";
  digest: string;
  text: string;
}

/**
 * Best-effort ARIA snapshot right after a navigation/search/click, so the
 * step-executor can fold it into `session.worldSnapshot` and the model
 * observes the current page in the next prompt's `### world` section.
 *
 * Swallows snapshot failures on purpose: the mutating tool (navigate,
 * search, …) already succeeded, and we do not want an ARIA timeout to
 * flip the tool status to `error`. Callers just skip the field when
 * `undefined` is returned. A page on a blocked host
 * (`browser.blockedDomains`), or embedding one in a frame, is never
 * captured: its content must not reach the model.
 */
export async function captureWorldSnapshot(
  backend: BrowserBackend,
  full = false,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  sessionId?: string,
): Promise<CapturedWorldSnapshot | undefined> {
  try {
    const snap = full ? await backend.snapshot({ full: true }) : await backend.snapshot();
    if (blockedHostOfPage(snap.url, snap.frameUrls, policy) !== null) return undefined;
    // The user's own Chrome: a site not cleared this session (a redirect
    // went elsewhere) is not captured; browser.read_aria asks for it.
    if (policy.userProfile && (sessionId === undefined || !userSiteCleared(policy, webHostOf(snap.url), sessionId))) {
      return undefined;
    }
    return {
      kind: "browser",
      digest: snap.digest,
      text: snap.text,
    };
  } catch {
    return undefined;
  }
}
