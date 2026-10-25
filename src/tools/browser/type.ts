import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import {
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gateBrowserAction } from "./gate-browser-action.js";

const REF_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * Typing into a password or payment field, and Enter that submits a
 * form, ask first (`classify-browser-action.ts`). The preview of a
 * secret shows only its length. A blocked host is refused.
 */
export function buildBrowserTypeTool(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
): ToolDefinition {
  return {
    name: "browser.type",
    description:
      "Type text into a textbox/searchbox addressed by `ref`. Optionally presses Enter.",
    readonly: false,
    async run(rawArgs, ctx) {
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
      const pressEnter = rawArgs.pressEnter === true;
      const refused = await gateBrowserAction(
        backend,
        dangerous,
        policy,
        { tool: "browser.type", kind: pressEnter ? "type_enter" : "type", ref, text },
        ctx,
      );
      if (refused) return refused;
      const result = await backend.type({
        ref,
        text,
        pressEnter,
        clearFirst: rawArgs.clearFirst === true,
      });
      return compressToolResult({
        tool: "browser.type",
        status: "ok",
        output: `typed ${result.typedLength} chars into ref=${ref}`,
        details: {
          ref,
          typedLength: result.typedLength,
          pressEnter,
        },
      });
    },
  };
}
