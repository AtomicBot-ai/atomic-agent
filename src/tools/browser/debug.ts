import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { BROWSER_PAGE_SOURCE } from "../untrusted-tool-output.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  EMPTY_DOMAIN_POLICY,
  hostMatchesAny,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { userSiteCleared } from "./user-profile-sites.js";
import {
  isFailedRequest,
  RING_ALL,
  type ConsoleEntry,
  type DebugLogKind,
  type NetworkEntry,
} from "./page-debug-log.js";

export const BROWSER_DEBUG_TOOL = "browser.debug";

export const DEBUG_ACTIONS: readonly DebugLogKind[] = ["console", "network"];
export const DEBUG_DEFAULT_LIMIT = 50;

function errorResult(output: string, details: Record<string, unknown>) {
  return compressToolResult({ tool: BROWSER_DEBUG_TOOL, status: "error", output: `${BROWSER_DEBUG_TOOL}: ${output}`, details });
}

function time(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function consoleLine(entry: ConsoleEntry): string {
  const source = entry.source ? `  (${entry.source})` : "";
  return `[${time(entry.at)}] ${entry.level.padEnd(9)} ${entry.text}${source}`;
}

function networkLine(entry: NetworkEntry): string {
  const outcome = entry.failure !== undefined ? `failed ${entry.failure}` : String(entry.status ?? "?");
  return `[${time(entry.at)}] ${entry.method} ${outcome} ${entry.resourceType} ${entry.url}`;
}

/**
 * An entry the model may see: not from a page on a blocked host, and in
 * the user's own Chrome not from a site this session has not cleared
 * (`user-profile-sites.ts`), the same line `read_aria` holds.
 */
function shown(pageUrl: string, policy: BrowserDomainPolicy, sessionId: string): boolean {
  const host = webHostOf(pageUrl);
  if (host !== null && hostMatchesAny(host, policy.blockedDomains)) return false;
  return userSiteCleared(policy, host, sessionId);
}

/**
 * `browser.debug { action: "console" | "network", errorsOnly?, limit?, clear? }`
 * (ATO-701): what the agent's pages logged and fetched, for "why does my
 * site not load". `console` lists console messages and uncaught page
 * errors; `network` lists finished requests with their status and failed
 * ones with the reason (`errorsOnly`: HTTP 4xx/5xx and failures only).
 * Newest last, at most `limit` (default 50, at most 200). `clear` empties
 * that list after reading, so the next call shows only what came after.
 *
 * Recorded by the backend from the moment the browser was attached
 * (`page-debug-log.ts`): bounded rings, text through the secret detector,
 * URLs without user info or secret query values, no headers or bodies.
 * The text is the site's own, so the result is framed as page content.
 */
export function buildBrowserDebugTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
): ToolDefinition {
  return {
    name: BROWSER_DEBUG_TOOL,
    description:
      "Page debugging: `action: \"console\"` lists recent console messages and page errors, `\"network\"` recent requests with status and failed requests. `errorsOnly`, `limit` (default 50), `clear` (empty the list after reading).",
    readonly: true,
    untrustedOutput: BROWSER_PAGE_SOURCE,
    async run(rawArgs, ctx) {
      const action = rawArgs.action;
      if (typeof action !== "string" || !(DEBUG_ACTIONS as readonly string[]).includes(action)) {
        return errorResult('`action` must be "console" or "network"', { reason: "bad_action" });
      }
      const kind = action as DebugLogKind;
      for (const flag of ["errorsOnly", "clear"] as const) {
        const value = rawArgs[flag];
        if (value !== undefined && value !== null && typeof value !== "boolean") {
          return errorResult(`\`${flag}\` must be a boolean`, { reason: "bad_args" });
        }
      }
      const rawLimit = rawArgs.limit;
      if (rawLimit !== undefined && rawLimit !== null && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit))) {
        return errorResult("`limit` must be a number", { reason: "bad_args" });
      }
      const limit = typeof rawLimit === "number" ? Math.min(RING_ALL, Math.max(1, Math.floor(rawLimit))) : DEBUG_DEFAULT_LIMIT;
      const errorsOnly = rawArgs.errorsOnly === true;

      if (!backend.debugLog) {
        return errorResult("this browser backend does not record console or network events", { reason: "unsupported" });
      }
      // Attach first: events are recorded from the attach on.
      await backend.ensureReady();
      const log = backend.debugLog();
      const all = kind === "console" ? log.console(errorsOnly) : log.network(errorsOnly);
      const visible = all.filter((entry) => shown(entry.pageUrl, policy, ctx.sessionId));
      const hidden = all.length - visible.length;
      const listed = visible.slice(-limit);
      if (rawArgs.clear === true) log.clear(kind);

      const noun = kind === "console" ? "console messages" : "requests";
      const header = [
        `${kind}: ${listed.length} of ${visible.length} ${errorsOnly ? (kind === "console" ? "errors" : "failed requests") : noun}, newest last`,
        ...(hidden > 0 ? [`  ${hidden} from blocked or not yet opened sites left out`] : []),
        ...(kind === "network" && !errorsOnly ? [`  failed: ${visible.filter((entry) => isFailedRequest(entry as NetworkEntry)).length}`] : []),
        ...(rawArgs.clear === true ? ["  list cleared"] : []),
      ];
      const lines =
        listed.length === 0
          ? [`  nothing recorded yet${errorsOnly ? "" : "; reload the page to capture its load"}`]
          : kind === "console"
            ? (listed as ConsoleEntry[]).map(consoleLine)
            : (listed as NetworkEntry[]).map(networkLine);
      return compressToolResult({
        tool: BROWSER_DEBUG_TOOL,
        status: "ok",
        output: [...header, ...lines].join("\n"),
        details: { kind, errorsOnly, count: listed.length, total: visible.length, hidden },
      });
    },
  };
}
