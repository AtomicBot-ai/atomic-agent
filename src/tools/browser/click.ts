import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, ClickInput } from "./browser-backend.js";

const REF_PATTERN = /^[a-zA-Z0-9]+$/;

export function buildBrowserClickTool(backend: BrowserBackend): ToolDefinition {
  return {
    name: "browser.click",
    description:
      "Click an element addressed by its `ref` (e.g. `e12`) from the latest ARIA snapshot.",
    readonly: false,
    async run(rawArgs) {
      const ref = rawArgs.ref;
      if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
        throw new Error(
          "browser.click: `ref` must be an alphanumeric string from the latest snapshot",
        );
      }
      const button = parseButton(rawArgs.button);
      const modifiers = parseModifiers(rawArgs.modifiers);
      await backend.ensureReady();
      // Preflight: refs are invalidated by any navigation or search
      // since the last `browser.read_aria`. Failing fast with a clear
      // message is much better than letting Playwright wait 30 s for a
      // locator that will never resolve.
      if (!(await backend.hasRef(ref))) {
        return compressToolResult({
          tool: "browser.click",
          status: "error",
          output: `ref '${ref}' is not present on the current page — refs are invalidated by any navigation or search; call browser.read_aria to get fresh refs`,
          details: { ref, reason: "stale_ref" },
        });
      }
      const payload: ClickInput = {
        ref,
        ...(button !== undefined ? { button } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      };
      const result = await backend.click(payload);
      return compressToolResult({
        tool: "browser.click",
        status: "ok",
        output: `clicked ref=${result.clickedRef}`,
        details: { ref: result.clickedRef },
      });
    },
  };
}

function parseButton(value: unknown): "left" | "right" | "middle" | undefined {
  if (value === "left" || value === "right" || value === "middle") return value;
  return undefined;
}

function parseModifiers(
  value: unknown,
): Array<"Alt" | "Control" | "Meta" | "Shift"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = ["Alt", "Control", "Meta", "Shift"] as const;
  const filtered = value.filter((v): v is (typeof allowed)[number] =>
    allowed.includes(v as never),
  );
  return filtered.length > 0 ? filtered : undefined;
}
