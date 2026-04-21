import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, SearchInput } from "./browser-backend.js";
import { captureWorldSnapshot } from "./capture-world-snapshot.js";

export function buildBrowserSearchTool(backend: BrowserBackend): ToolDefinition {
  return {
    name: "browser.search",
    description:
      "Open a search-engine results page for the given query. Engine defaults to google.",
    readonly: false,
    async run(rawArgs) {
      const query = rawArgs.query;
      if (typeof query !== "string" || query.length === 0) {
        throw new Error("browser.search: `query` must be a non-empty string");
      }
      const engine = parseEngine(rawArgs.engine);
      await backend.ensureReady();
      const payload: SearchInput = {
        query,
        ...(engine !== undefined ? { engine } : {}),
      };
      const result = await backend.search(payload);
      const worldSnapshot = await captureWorldSnapshot(backend);
      return compressToolResult({
        tool: "browser.search",
        status: "ok",
        output: `opened search results: ${result.url}`,
        details: {
          url: result.url,
          engine: engine ?? "google",
          ...(worldSnapshot ? { worldSnapshot } : {}),
        },
      });
    },
  };
}

function parseEngine(
  value: unknown,
): "google" | "duckduckgo" | "bing" | undefined {
  if (value === "google" || value === "duckduckgo" || value === "bing") {
    return value;
  }
  return undefined;
}
