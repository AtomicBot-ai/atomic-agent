import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, TabsInput } from "./browser-backend.js";

export function buildBrowserTabsTool(backend: BrowserBackend): ToolDefinition {
  return {
    name: "browser.tabs",
    description:
      "Manage browser tabs: list, switch, close, or open a new one.",
    readonly: false,
    async run(rawArgs) {
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
      if (typeof rawArgs.url === "string") {
        input.url = rawArgs.url;
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
