import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import type { BrowserBackend, SiteToolsListing } from "./browser-backend.js";
import {
  blockedDomainMessage,
  EMPTY_DOMAIN_POLICY,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gatePageRead, type PageReadVerdict } from "./gate-page-read.js";
import {
  checkSiteToolArgs,
  sanitizeSiteTools,
  SITE_TOOL_LIMITS,
  SITE_TOOL_NAME_PATTERN,
  type SiteTool,
  type SiteToolListing,
} from "./site-tools-sanitize.js";

export const BROWSER_SITE_TOOLS_TOOL = "browser.site_tools";

/** Source named on the framing of every result: the site wrote the descriptions and the answers. */
export const SITE_TOOL_SOURCE = "a web page's own tools (WebMCP) in the browser";

const PREVIEW_ARGS_CAP = 300;
const PREVIEW_DESCRIPTION_CAP = 120;
const SCHEMA_SHOWN_CAP = 1_200;

type Args = Record<string, unknown>;

function errorResult(output: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: BROWSER_SITE_TOOLS_TOOL, status: "error", output, details });
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** A refusal for a page-read verdict that is not `ok`, else `null`. */
function refusal(verdict: PageReadVerdict, url: string, after: boolean): CompressedToolResult | null {
  if (verdict.kind === "blocked") {
    const tail = after ? " The page showed that site, so its answer was discarded." : "";
    return errorResult(`${blockedDomainMessage(BROWSER_SITE_TOOLS_TOOL, verdict.host)}${tail}`, {
      url,
      host: verdict.host,
      reason: "blocked_domain",
    });
  }
  if (verdict.kind === "user_site_not_cleared") {
    const tail = after ? "; the page moved there, so its answer was discarded." : "";
    return errorResult(
      `${BROWSER_SITE_TOOLS_TOOL}: ${verdict.host} has not been opened in your own Chrome this session${tail}`,
      { url, host: verdict.host, reason: "user_site_not_cleared" },
    );
  }
  return null;
}

/** `{ ... }` arguments: an object, a JSON string of one, or absent (`{}`). */
function parseCallArguments(raw: unknown): Args {
  if (raw === undefined || raw === null) return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${BROWSER_SITE_TOOLS_TOOL}: \`arguments\` must be a JSON object`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${BROWSER_SITE_TOOLS_TOOL}: \`arguments\` must be an object of named arguments`);
  }
  return value as Args;
}

function parseTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return SITE_TOOL_LIMITS.defaultTimeoutMs;
  return Math.min(Math.max(Math.trunc(raw), 1_000), SITE_TOOL_LIMITS.maxTimeoutMs);
}

function renderTool(tool: SiteTool): string[] {
  const title = tool.title && tool.title !== tool.name ? ` (${tool.title})` : "";
  const hint = tool.readOnlyHint ? " [the site says it only reads]" : "";
  const lines = [`- ${tool.name}${title}: ${tool.description || "(no description)"}${hint}`];
  lines.push(
    tool.inputSchema === null
      ? "  arguments: none declared"
      : `  arguments schema: ${clip(JSON.stringify(tool.inputSchema), SCHEMA_SHOWN_CAP)}`,
  );
  return lines;
}

function renderListing(host: string | null, url: string, listing: SiteToolListing): string {
  if (listing.tools.length === 0 && listing.skipped.length === 0) {
    return `${url} declares no site tools (WebMCP). Work with the page through browser.read_aria, browser.click and browser.type.`;
  }
  const lines = [
    `${listing.tools.length} site tool(s) declared by ${host ?? url} through WebMCP` +
      (listing.total > listing.tools.length ? ` (${listing.total} declared in all)` : "") +
      ".",
    `Run one with browser.site_tools { "action": "call", "name": "<name>", "arguments": { ... } }; every call asks the user first.`,
    "Names, descriptions and schemas below are the site's own words.",
    ...listing.tools.flatMap(renderTool),
  ];
  if (listing.skipped.length > 0) {
    lines.push(
      `skipped: ${listing.skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The approval preview: which tool, on which site, with which arguments. */
export function buildSiteToolPreview(host: string, tool: SiteTool, argsJson: string): string {
  const about = tool.description ? ` (${clip(tool.description, PREVIEW_DESCRIPTION_CAP)})` : "";
  return `run ${host}'s own tool "${tool.name}"${about} with ${clip(argsJson, PREVIEW_ARGS_CAP)}`;
}

interface ListedPage {
  url: string;
  host: string | null;
  listing: SiteToolListing;
}

async function readListing(
  backend: BrowserBackend,
  list: NonNullable<BrowserBackend["listSiteTools"]>,
  policy: BrowserDomainPolicy,
  dangerous: DangerousToolOptions | undefined,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<ListedPage | CompressedToolResult> {
  const before = await backend.currentUrl();
  const gateBefore = await gatePageRead(
    { url: before },
    policy,
    ctx.sessionId,
    dangerous ? { dangerous, tool: BROWSER_SITE_TOOLS_TOOL, signal: ctx.signal } : undefined,
  );
  const refusedBefore = refusal(gateBefore, before, false);
  if (refusedBefore) return refusedBefore;
  const raw: SiteToolsListing = await list({
    maxScan: SITE_TOOL_LIMITS.maxScan,
    maxSchemaChars: SITE_TOOL_LIMITS.maxSchemaChars,
    maxDescriptionChars: SITE_TOOL_LIMITS.maxDescriptionChars,
  });
  const refusedAfter = refusal(await gatePageRead(raw, policy, ctx.sessionId), raw.url, true);
  if (refusedAfter) return refusedAfter;
  return {
    url: raw.url,
    host: webHostOf(raw.url),
    listing: sanitizeSiteTools(raw.tools, raw.total),
  };
}

/**
 * `browser.site_tools { action: "list" | "call", name?, arguments?, timeoutMs? }`
 * (ATO-521): the tools the open page declares for agents through WebMCP
 * (`document.modelContext.registerTool`, or the older
 * `navigator.modelContext`). One agent tool for every site's tools, so
 * the catalog never grows with the page.
 *
 * - `list` reads them (main frame only), checked and capped
 *   (`site-tools-sanitize.ts`). It is a page read like `read_aria`: a
 *   blocked page is refused, and in the user's own Chrome a site not
 *   opened this session asks first (`gate-page-read.ts`).
 * - `call` re-reads the list, checks the arguments against the declared
 *   schema, then asks as `browser_site_tool` (silent from level 4 like a
 *   submit, grantable for one site per session); in the user's own Chrome
 *   it asks as `browser_secret`, every time, since the site acts as them.
 *   The site's "read-only" hint never skips the prompt: the page can lie.
 *   The answer is discarded when the page moved to a blocked site.
 *
 * Descriptions, schemas and answers are the site's own text, framed as
 * outside data (`untrustedOutput`).
 */
export function buildBrowserSiteToolsTool(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
): ToolDefinition {
  return {
    name: BROWSER_SITE_TOOLS_TOOL,
    description:
      "Tools the open page declares for AI agents (WebMCP). `list` shows them with their argument schemas; `call` runs one by `name` with `arguments` (asks first). Prefer this over clicking when the page offers a tool for the job.",
    readonly: false,
    untrustedOutput: SITE_TOOL_SOURCE,
    async run(rawArgs, ctx) {
      const action = rawArgs.action;
      if (action !== "list" && action !== "call") {
        throw new Error(`${BROWSER_SITE_TOOLS_TOOL}: \`action\` must be one of list|call`);
      }
      const { listSiteTools, callSiteTool } = backend;
      if (listSiteTools === undefined || callSiteTool === undefined) {
        return errorResult(`${BROWSER_SITE_TOOLS_TOOL}: this browser backend cannot read site tools`, {
          reason: "unsupported",
        });
      }
      let name = "";
      let args: Args = {};
      if (action === "call") {
        name = typeof rawArgs.name === "string" ? rawArgs.name : "";
        if (!SITE_TOOL_NAME_PATTERN.test(name)) {
          throw new Error(`${BROWSER_SITE_TOOLS_TOOL}: \`name\` must be a tool name from action "list"`);
        }
        args = parseCallArguments(rawArgs.arguments);
      }
      await backend.ensureReady();
      const page = await readListing(backend, listSiteTools.bind(backend), policy, dangerous, ctx);
      if (!("listing" in page)) return page;
      if (action === "list") {
        return compressToolResult(
          {
            tool: BROWSER_SITE_TOOLS_TOOL,
            status: "ok",
            output: renderListing(page.host, page.url, page.listing),
            details: {
              action,
              url: page.url,
              tools: page.listing.tools.map((tool) => tool.name),
              skipped: page.listing.skipped,
              total: page.listing.total,
            },
          },
          { maxSummaryLength: 12_000, maxTailLines: 200 },
        );
      }
      const tool = page.listing.tools.find((entry) => entry.name === name);
      if (tool === undefined) {
        return errorResult(
          `${BROWSER_SITE_TOOLS_TOOL}: ${page.url} declares no tool named "${name}"; call action "list" to see the tools it has now`,
          { name, url: page.url, reason: "not_found" },
        );
      }
      if (page.host === null) {
        return errorResult(`${BROWSER_SITE_TOOLS_TOOL}: site tools run only on http(s) pages`, {
          name,
          url: page.url,
          reason: "not_web",
        });
      }
      const argsJson = JSON.stringify(args);
      if (argsJson.length > SITE_TOOL_LIMITS.maxArgsChars) {
        return errorResult(
          `${BROWSER_SITE_TOOLS_TOOL}: the arguments are over ${SITE_TOOL_LIMITS.maxArgsChars} characters of JSON`,
          { name, reason: "args_too_large" },
        );
      }
      const problems = checkSiteToolArgs(tool.inputSchema, args);
      if (problems.length > 0) {
        return errorResult(
          `${BROWSER_SITE_TOOLS_TOOL}: arguments do not match "${name}": ${problems.join("; ")}. Its schema: ${clip(JSON.stringify(tool.inputSchema), SCHEMA_SHOWN_CAP)}`,
          { name, reason: "bad_arguments", problems },
        );
      }
      // In the user's own Chrome the site acts as them, on their signed-in
      // account: ask every time, never covered by a session grant.
      const userChrome = policy.userProfile === true;
      await requireApproval(
        dangerous,
        {
          sessionId: ctx.sessionId,
          tool: BROWSER_SITE_TOOLS_TOOL,
          category: userChrome ? "browser_secret" : "browser_site_tool",
          reason: userChrome
            ? `in your own Chrome: ${page.host} runs its own tool "${name}" as you`
            : `${page.host} runs its own tool "${name}"`,
          preview: buildSiteToolPreview(page.host, tool, argsJson),
          affectedResources: [page.host],
        },
        ctx.signal,
      );
      const timeoutMs = parseTimeout(rawArgs.timeoutMs);
      const outcome = await callSiteTool.call(backend, {
        name,
        argsJson,
        timeoutMs,
        maxResultChars: SITE_TOOL_LIMITS.maxResultChars,
      });
      const refusedAfter = refusal(await gatePageRead(outcome, policy, ctx.sessionId), outcome.url, true);
      if (refusedAfter) return refusedAfter;
      if (!outcome.ok) {
        const why =
          outcome.error === "timeout"
            ? `did not answer within ${Math.round(timeoutMs / 1000)} s`
            : outcome.error === "not_found"
              ? "is no longer declared on the page"
              : outcome.error === "bad_args"
                ? "could not read the arguments"
                : `failed${outcome.message ? `: ${outcome.message}` : ""}`;
        return errorResult(`${BROWSER_SITE_TOOLS_TOOL}: "${name}" on ${page.host} ${why}`, {
          name,
          url: outcome.url,
          reason: outcome.error ?? "failed",
        });
      }
      const truncated = outcome.text.length > SITE_TOOL_LIMITS.maxResultChars;
      const text = truncated ? outcome.text.slice(0, SITE_TOOL_LIMITS.maxResultChars) : outcome.text;
      const lines = [
        `"${name}" on ${page.host} ${outcome.isError ? "reported an error" : "answered"}:`,
        text.length > 0 ? text : "(empty answer)",
        ...(truncated ? [`[answer cut at ${SITE_TOOL_LIMITS.maxResultChars} characters]`] : []),
        "The page may have changed; call browser.read_aria before clicking on it.",
      ];
      return compressToolResult(
        {
          tool: BROWSER_SITE_TOOLS_TOOL,
          status: outcome.isError ? "error" : "ok",
          output: lines.join("\n"),
          details: { action, name, url: outcome.url, host: page.host, truncated, siteError: outcome.isError },
        },
        { maxSummaryLength: 12_000, maxTailLines: 400 },
      );
    },
  };
}
