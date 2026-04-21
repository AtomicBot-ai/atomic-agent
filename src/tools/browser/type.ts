import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";

const REF_PATTERN = /^[a-zA-Z0-9]+$/;

export function buildBrowserTypeTool(backend: BrowserBackend): ToolDefinition {
  return {
    name: "browser.type",
    description:
      "Type text into a textbox/searchbox addressed by `ref`. Optionally presses Enter.",
    readonly: false,
    async run(rawArgs) {
      const ref = rawArgs.ref;
      const text = rawArgs.text;
      if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
        throw new Error(
          "browser.type: `ref` must be an alphanumeric string from the latest snapshot",
        );
      }
      if (typeof text !== "string") {
        throw new Error("browser.type: `text` must be a string");
      }
      await backend.ensureReady();
      // Preflight: see browser.click for rationale. Refs from an older
      // snapshot die the moment the page navigates or re-renders.
      if (!(await backend.hasRef(ref))) {
        return compressToolResult({
          tool: "browser.type",
          status: "error",
          output: `ref '${ref}' is not present on the current page — refs are invalidated by any navigation or search; call browser.read_aria to get fresh refs`,
          details: { ref, reason: "stale_ref" },
        });
      }
      const result = await backend.type({
        ref,
        text,
        pressEnter: rawArgs.pressEnter === true,
        clearFirst: rawArgs.clearFirst === true,
      });
      return compressToolResult({
        tool: "browser.type",
        status: "ok",
        output: `typed ${result.typedLength} chars into ref=${ref}`,
        details: {
          ref,
          typedLength: result.typedLength,
          pressEnter: rawArgs.pressEnter === true,
        },
      });
    },
  };
}
