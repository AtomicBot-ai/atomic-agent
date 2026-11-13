import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import { requireUserSite } from "./user-profile-sites.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserUrl,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import {
  isOfflineNetwork,
  offlineRefusal,
  type OfflineNetworkError,
} from "../../llm/offline-network.js";

/** Schemes that never leave the machine; anything else is checked by host. */
const LOCAL_SCHEMES = new Set(["about:", "file:", "data:", "blob:"]);

/**
 * Offline mode (ATO-1084): the refusal for opening `url`, or `null`.
 * http(s) / ws(s) URLs pass only on this machine; `about:`, `file:`,
 * `data:` and `blob:` pass; any other scheme is refused while offline,
 * since the agent cannot tell what Chrome would fetch for it.
 */
export function offlineBrowserRefusal(
  tool: string,
  url: string,
): OfflineNetworkError | null {
  if (!isOfflineNetwork()) return null;
  let protocol: string;
  try {
    protocol = new URL(url.trim()).protocol.toLowerCase();
  } catch {
    return offlineRefusal(url, tool);
  }
  if (LOCAL_SCHEMES.has(protocol)) return null;
  return offlineRefusal(url.trim(), tool);
}

function offlineToolError(
  tool: string,
  url: string,
  refused: OfflineNetworkError,
  suffix = "",
): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output: `${refused.message}${suffix}`,
    details: { url, host: refused.host, reason: "offline_mode" },
  });
}

/** http(s) or `about:blank`: all the user's own Chrome may be sent to. */
export function isUserProfileUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.toLowerCase() === "about:blank") return true;
  try {
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Domain-list gate for anything that opens a URL (`browser.navigate`,
 * `browser.tabs` new, `browser.search`). A blocked host comes back as a
 * tool error at every approval level; a host outside a non-empty
 * allow-list asks as `browser_offsite`. In the user's own Chrome
 * (`policy.userProfile`) a non-web URL is refused as a tool error and a
 * site not yet opened this session asks (`user-profile-sites.ts`). `null`
 * means "go ahead" (the caller still applies its own `browser_nonweb` gate).
 */
export async function gateBrowserUrl(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  url: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<CompressedToolResult | null> {
  const offline = offlineBrowserRefusal(tool, url);
  if (offline) return offlineToolError(tool, url, offline);
  if (policy.userProfile && !isUserProfileUrl(url)) {
    return compressToolResult({
      tool,
      status: "error",
      output: `${tool}: in your own Chrome the agent opens only http(s) pages. chrome://, file:// and other browser pages (saved passwords, settings, history, local files) are off limits.`,
      details: { url, reason: "user_profile_nonweb" },
    });
  }
  const verdict = checkBrowserUrl(url, policy);
  if (verdict.kind === "blocked") {
    return compressToolResult({
      tool,
      status: "error",
      output: blockedDomainMessage(tool, verdict.host),
      details: { url, host: verdict.host, reason: "blocked_domain" },
    });
  }
  if (policy.userProfile) {
    // The user's own Chrome: a new site asks once per session (stricter
    // than `browser_offsite`, which it replaces here).
    await requireUserSite(dangerous, policy, tool, verdict.host, url, ctx);
    return null;
  }
  if (verdict.kind === "offsite") {
    await requireApproval(
      dangerous,
      {
        sessionId: ctx.sessionId,
        tool,
        category: "browser_offsite",
        reason: `${verdict.host} is not in browser.allowedDomains`,
        preview: url,
        affectedResources: [verdict.host],
      },
      ctx.signal,
    );
  }
  return null;
}

/**
 * After an action that can move the browser (navigate, tabs new, a
 * click, Enter, a search), re-check where it landed: a redirect or a
 * link can end on a blocked host even when the URL asked for was fine.
 * On a blocked host the tab is sent to `about:blank` (so nothing from it
 * reaches the next snapshot) and a `blocked_domain` tool error comes
 * back; otherwise `null`. Best effort: a click that starts a navigation
 * later than the click itself returns is caught by the next read
 * (`browser.read_aria`), which refuses a blocked page too.
 *
 * Skipped while `blockedDomains` is empty and offline mode is off, so it
 * costs nothing then.
 */
export async function recheckLandedPage(
  backend: Pick<BrowserBackend, "currentUrl" | "navigate">,
  policy: BrowserDomainPolicy,
  tool: string,
  landedUrl?: string,
): Promise<CompressedToolResult | null> {
  const offline = isOfflineNetwork();
  if (policy.blockedDomains.length === 0 && !offline) return null;
  let url = landedUrl;
  if (url === undefined) {
    try {
      url = await backend.currentUrl();
    } catch {
      return null;
    }
  }
  // ATO-1084: a link or redirect that left this machine while offline.
  const refused = offline ? offlineBrowserRefusal(tool, url) : null;
  if (refused) {
    await backend.navigate({ url: "about:blank" }).catch(() => undefined);
    return offlineToolError(tool, url, refused, " The action ended on that site, so the tab was cleared.");
  }
  const verdict = checkBrowserUrl(url, policy);
  if (verdict.kind !== "blocked") return null;
  await backend.navigate({ url: "about:blank" }).catch(() => undefined);
  return compressToolResult({
    tool,
    status: "error",
    output: `${blockedDomainMessage(tool, verdict.host)} The action ended on that site, so the tab was cleared.`,
    details: { url, host: verdict.host, reason: "blocked_domain" },
  });
}
