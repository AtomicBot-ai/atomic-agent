import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, TabsInput } from "./browser-backend.js";
import { isSafeUrl } from "./navigate.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

export function buildBrowserTabsTool(
  backend: BrowserBackend,
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "browser.tabs",
    description:
      "Manage browser tabs: list, switch, close, or open a new one. Opening a new tab with a non-http(s) URL requires approval (same gate as browser.navigate).",
    readonly: false,
    async run(rawArgs, ctx) {
      const action = rawArgs.action;
      if (
        action !== "list" &&
        action !== "switch" &&
        action !== "close" &&
        action !== "new"
      ) {
        throw new Error(
          "browser.tabs: `action` must be one of list|switch|close|new",
        );
      }
      const input: TabsInput = { action };
      if (typeof rawArgs.index === "number" && Number.isInteger(rawArgs.index)) {
        input.index = rawArgs.index;
      }
      if (typeof rawArgs.url === "string" && rawArgs.url.length > 0) {
        input.url = rawArgs.url;
      }

      // Mirror browser.navigate: tabs.new with a URL is the same danger surface
      // (file://, javascript:, data:, chrome://). Without this gate the model
      // can exfiltrate local files or execute script by opening a secondary tab.
      if (action === "new" && input.url !== undefined && !isSafeUrl(input.url)) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "browser.tabs",
            category: "browser_nonweb",
            reason: "non-http(s) URL requested for new tab",
            preview: input.url,
            affectedResources: [input.url],
          },
          ctx.signal,
        );
      }

      await backend.ensureReady();
      const result = await backend.tabs(input);
      const rendered = result.tabs
        .map(
          (t) =>
            `${t.active ? "*" : " "}[${t.index}] ${t.title || "(untitled)"} — ${t.url}`,
        )
        .join("\n");
      return compressToolResult({
        tool: "browser.tabs",
        status: "ok",
        output: rendered || "(no open tabs)",
        details: { action, tabs: result.tabs },
      });
    },
  };
}
