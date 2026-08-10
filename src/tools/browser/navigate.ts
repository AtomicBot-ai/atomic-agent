import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend } from "./browser-backend.js";
import { captureWorldSnapshot } from "./capture-world-snapshot.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * Return `true` only when the scheme is http(s). Anything else —
 * `file://`, `javascript:`, `chrome://`, `data:` — is considered
 * dangerous and must pass through the approval gate.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SAFE_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function buildBrowserNavigateTool(
  backend: BrowserBackend,
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "browser.navigate",
    description:
      "Navigate the active tab to a URL. Non-http(s) schemes require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const url = rawArgs.url;
      if (typeof url !== "string" || url.length === 0) {
        throw new Error("browser.navigate: `url` must be a non-empty string");
      }
      if (!isSafeUrl(url)) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "browser.navigate",
            category: "browser_nonweb",
            reason: "non-http(s) URL requested",
            preview: url,
            affectedResources: [url],
          },
          ctx.signal,
        );
      }
      const waitUntil = parseWaitUntil(rawArgs.waitUntil);
      const timeoutMs = parseNumber(rawArgs.timeoutMs);
      await backend.ensureReady();
      const result = await backend.navigate({
        url,
        ...(waitUntil !== undefined ? { waitUntil } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const worldSnapshot = await captureWorldSnapshot(backend);
      return compressToolResult({
        tool: "browser.navigate",
        status: "ok",
        output: `navigated to ${result.url} (${result.title})`,
        details: {
          url: result.url,
          title: result.title,
          ...(worldSnapshot ? { worldSnapshot } : {}),
        },
      });
    },
  };
}

function parseWaitUntil(
  value: unknown,
): "load" | "domcontentloaded" | "networkidle" | undefined {
  if (
    value === "load" ||
    value === "domcontentloaded" ||
    value === "networkidle"
  ) {
    return value;
  }
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
