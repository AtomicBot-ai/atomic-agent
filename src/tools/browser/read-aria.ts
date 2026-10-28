import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserUrl,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";

/** A page on a blocked host is refused: none of its content reaches the model. */
export function buildBrowserReadAriaTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
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
      const verdict = checkBrowserUrl(snapshot.url, policy);
      if (verdict.kind === "blocked") {
        return compressToolResult({
          tool: "browser.read_aria",
          status: "error",
          output: blockedDomainMessage("browser.read_aria", verdict.host),
          details: { host: verdict.host, reason: "blocked_domain" },
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
