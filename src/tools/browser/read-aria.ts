import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import {
  blockedDomainMessage,
  blockedHostOfPage,
  EMPTY_DOMAIN_POLICY,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { requireUserSite, userSiteCleared } from "./user-profile-sites.js";

/**
 * A page on a blocked host, or framing one, is refused: none of its
 * content reaches the model. In the user's own Chrome a site not yet
 * cleared this session asks first (`dangerous`; without it, refused).
 */
export function buildBrowserReadAriaTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  dangerous?: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "browser.read_aria",
    description:
      "Capture a compact ARIA snapshot of the active page with stable `ref` identifiers.",
    readonly: true,
    async run(rawArgs, ctx) {
      const depth =
        typeof rawArgs.depth === "number" && Number.isFinite(rawArgs.depth)
          ? Math.max(1, Math.floor(rawArgs.depth))
          : undefined;
      await backend.ensureReady();
      const snapshot = await backend.snapshot(
        { ...(depth !== undefined ? { depth } : {}), ...(ctx.modelMode === "cloud" ? { full: true } : {}) },
      );
      const blocked = blockedHostOfPage(snapshot.url, snapshot.frameUrls, policy);
      if (blocked !== null) {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: blockedDomainMessage("browser.read_aria", blocked),
          details: { host: blocked, reason: "blocked_domain" },
        });
      }
      // The user's own Chrome: reading a site is reading their account;
      // a site not opened through a prompt this session asks first.
      const host = webHostOf(snapshot.url);
      if (dangerous) {
        await requireUserSite(dangerous, policy, "browser.read_aria", host, `read ${snapshot.url}`, ctx);
      } else if (!userSiteCleared(policy, host, ctx.sessionId)) {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: `browser.read_aria: ${host} has not been opened in your own Chrome this session`,
          details: { host, reason: "user_site_not_cleared" },
        });
      }
      // The ARIA tree is deliberately NOT duplicated in the tool_result
      // summary: it already lands in `session.worldSnapshot` through
      // `details.worldSnapshot` and appears in the prompt's `### world`
      // section. Echoing it here would make the conversation tail fight
      // with `### world` for the model's attention and cause "I haven't
      // seen results, search again" loops.
      const output = [
        `captured ARIA snapshot`,
        `  url: ${snapshot.url}`,
        `  title: ${snapshot.title}`,
        `  refs: ${snapshot.refs.length}`,
        `  digest: ${snapshot.digest}`,
        `  see ### world for full page contents`,
      ].join("\n");
      return compressToolResult({
        tool: "browser.read_aria",
        status: "ok",
        output,
        details: {
          url: snapshot.url,
          title: snapshot.title,
          digest: snapshot.digest,
          refCount: snapshot.refs.length,
          // Surfaced to step-executor.applyStateEffects so the ARIA tree
          // lands in `session.worldSnapshot` and the next prompt's
          // `### world` section reflects the current page.
          worldSnapshot: {
            kind: "browser" as const,
            digest: snapshot.digest,
            text: snapshot.text,
          },
        },
      });
    },
  };
}
