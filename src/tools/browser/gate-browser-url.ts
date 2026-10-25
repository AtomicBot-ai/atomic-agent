import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import {
  blockedDomainMessage,
  checkBrowserUrl,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";

/**
 * Domain-list gate for anything that opens a URL (`browser.navigate`,
 * `browser.tabs` new, `browser.search`). A blocked host comes back as a
 * tool error at every approval level; a host outside a non-empty
 * allow-list asks as `browser_offsite`. `null` means "go ahead" (the
 * caller still applies its own `browser_nonweb` gate).
 */
export async function gateBrowserUrl(
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  tool: string,
  url: string,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<CompressedToolResult | null> {
  const verdict = checkBrowserUrl(url, policy);
  if (verdict.kind === "blocked") {
    return compressToolResult({
      tool,
      status: "error",
      output: blockedDomainMessage(tool, verdict.host),
      details: { url, host: verdict.host, reason: "blocked_domain" },
    });
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
