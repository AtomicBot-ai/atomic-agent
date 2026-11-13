import type { BrowserContext, Page } from "playwright-core";
import type {
  SiteToolCallInput,
  SiteToolCallResult,
  SiteToolsListInput,
  SiteToolsListing,
} from "./browser-backend.js";
import {
  callSiteToolExpression,
  listSiteToolsExpression,
  SITE_TOOLS_INIT_SCRIPT,
} from "./site-tools-in-page.js";

/**
 * Playwright side of WebMCP site tools (ATO-521), kept out of
 * `playwright-backend.ts` so the backend only delegates.
 */

/** Extra time past the page-side timeout before Node gives up on a page that hangs. */
const NODE_GRACE_MS = 3_000;

/**
 * Record the tools pages register. The agent's own browser: every page of
 * the context. The user's own Chrome: only a tab the agent opened (pass
 * the page), never the user's other tabs. Takes effect on the next
 * navigation; failures are ignored (the page then simply has no tools).
 */
export async function installSiteToolCapture(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript({ content: SITE_TOOLS_INIT_SCRIPT }).catch(() => undefined);
}

export async function listSiteToolsOnPage(
  page: Page,
  input: SiteToolsListInput,
): Promise<SiteToolsListing> {
  const raw = (await page
    .evaluate(listSiteToolsExpression(input))
    .catch(() => ({ total: 0, tools: [] }))) as { total?: unknown; tools?: unknown };
  const tools = Array.isArray(raw?.tools) ? (raw.tools as unknown[]) : [];
  const total = typeof raw?.total === "number" && Number.isFinite(raw.total) ? raw.total : tools.length;
  return { url: page.url(), frameUrls: page.frames().map((frame) => frame.url()), tools, total };
}

export async function callSiteToolOnPage(
  page: Page,
  input: SiteToolCallInput,
): Promise<SiteToolCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ ok: false; error: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), input.timeoutMs + NODE_GRACE_MS);
  });
  let raw: Record<string, unknown>;
  try {
    raw = (await Promise.race([
      page.evaluate(callSiteToolExpression(input)).catch((error: unknown) => ({
        ok: false,
        error: "threw",
        message: error instanceof Error ? error.message.slice(0, 500) : "",
      })),
      hung,
    ])) as Record<string, unknown>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const base = { url: page.url(), frameUrls: page.frames().map((frame) => frame.url()) };
  if (raw?.ok !== true) {
    return {
      ...base,
      ok: false,
      text: "",
      isError: false,
      error: typeof raw?.error === "string" ? raw.error : "threw",
      ...(typeof raw?.message === "string" && raw.message.length > 0 ? { message: raw.message } : {}),
    };
  }
  return {
    ...base,
    ok: true,
    text: typeof raw.text === "string" ? raw.text : "",
    isError: raw.isError === true,
  };
}
