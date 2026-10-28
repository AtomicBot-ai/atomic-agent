import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolContext } from "../tool-registry.js";
import type { BrowserBackend, RefDescription } from "./browser-backend.js";
import {
  blockedDomainMessage,
  checkBrowserHost,
  checkBrowserUrl,
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { requireUserSite } from "./user-profile-sites.js";
import {
  classifyBrowserAction,
  type BrowserActionKind,
} from "./classify-browser-action.js";

export interface BrowserActionRequest {
  tool: "browser.click" | "browser.type";
  kind: BrowserActionKind;
  ref: string;
  /** Text `browser.type` is about to enter; shown only for non-secret commits. */
  text?: string;
}

const NAME_PREVIEW_CAP = 80;
const TEXT_PREVIEW_CAP = 120;

async function describeSafely(
  backend: BrowserBackend,
  ref: string,
): Promise<RefDescription | null> {
  try {
    return await backend.describeRef(ref);
  } catch {
    return null;
  }
}

function quote(text: string, cap: number): string {
  const trimmed = text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
  return `"${trimmed}"`;
}

function elementLabel(element: RefDescription | null, ref: string): string {
  if (element === null) return `ref ${ref} (could not inspect)`;
  const kind = element.type ?? element.role ?? element.tag;
  const name = element.name ? `${quote(element.name, NAME_PREVIEW_CAP)} ` : "";
  return `${name}(${kind})`;
}

/**
 * The approval preview. A secret never shows its text, only its length;
 * an uninspectable target does not either (it might be a password
 * field). Telegram and the desktop render this verbatim.
 */
export function buildBrowserActionPreview(
  request: BrowserActionRequest,
  element: RefDescription | null,
  host: string | null,
  secret: boolean,
): string {
  const where = host ? ` on ${host}` : "";
  const target = elementLabel(element, request.ref);
  if (request.kind === "click") return `click ${target}${where}`;
  const text = request.text ?? "";
  const shown =
    secret || element === null
      ? `${text.length} chars (hidden)`
      : quote(text, TEXT_PREVIEW_CAP);
  const enter = request.kind === "type_enter" ? ", then Enter" : "";
  return `type ${shown} into ${target}${where}${enter}`;
}

/**
 * Where the action sends the browser, when the element says: a link's
 * `href`, or the form `action` a submit (click or Enter) posts to,
 * resolved against the element's page. `null` when it does not navigate
 * by itself (or the URL is not one we can read).
 */
export function actionTargetUrl(
  kind: BrowserActionRequest["kind"],
  element: RefDescription,
): string | null {
  let raw: string | null = null;
  if (kind === "click") {
    raw = element.href ?? (element.isSubmit ? (element.formAction ?? "") : null);
  } else if (kind === "type_enter" && element.inForm) {
    raw = element.formAction ?? "";
  }
  if (raw === null) return null;
  try {
    return new URL(raw, element.pageUrl).href;
  } catch {
    return null;
  }
}

async function currentUrlSafely(backend: BrowserBackend): Promise<string | null> {
  try {
    return await backend.currentUrl();
  } catch {
    return null;
  }
}

function blockedResult(tool: string, ref: string, host: string): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output: blockedDomainMessage(tool, host),
    details: { ref, host, reason: "blocked_domain" },
  });
}

/**
 * Runs after the stale-ref preflight and before the backend acts.
 * Returns a tool-error result when the page's host, or the host a link
 * or form would go to, is blocked; throws `ApprovalDeniedError` when the
 * operator says no; resolves `null` when the action may go ahead.
 *
 * Order: blocked page → blocked / off-site target (`browser_offsite`) →
 * the action's own category (`classify-browser-action.ts`); in the
 * user's own Chrome `browser_commit` asks as `browser_secret`.
 */
export async function gateBrowserAction(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  request: BrowserActionRequest,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<CompressedToolResult | null> {
  const element = await describeSafely(backend, request.ref);
  // Without element facts the page URL still comes from the backend, so
  // a blocked host is refused even when the element cannot be read.
  const pageUrl = element ? element.pageUrl : await currentUrlSafely(backend);
  const host = pageUrl !== null ? webHostOf(pageUrl) : null;
  if (host !== null && checkBrowserHost(host, policy).kind === "blocked") {
    return blockedResult(request.tool, request.ref, host);
  }
  const targetUrl = element ? actionTargetUrl(request.kind, element) : null;
  if (targetUrl !== null) {
    const target = checkBrowserUrl(targetUrl, policy);
    if (target.kind === "blocked") return blockedResult(request.tool, request.ref, target.host);
    if (policy.userProfile) {
      await requireUserSite(
        dangerous,
        policy,
        request.tool,
        target.host,
        `${buildBrowserActionPreview(request, element, host, true)} → ${targetUrl}`,
        ctx,
      );
    } else if (target.kind === "offsite") {
      await requireApproval(
        dangerous,
        {
          sessionId: ctx.sessionId,
          tool: request.tool,
          category: "browser_offsite",
          reason: `${target.host} is not in browser.allowedDomains`,
          preview: `${buildBrowserActionPreview(request, element, host, true)} → ${targetUrl}`,
          affectedResources: [target.host],
        },
        ctx.signal,
      );
    }
  }
  const verdict = classifyBrowserAction(request.kind, element);
  if (verdict.category === null) return null;
  // In the user's own Chrome a submit acts as them, on their signed-in
  // accounts: it asks every time and is never covered by a session grant.
  const escalate = policy.userProfile === true && verdict.category === "browser_commit";
  await requireApproval(
    dangerous,
    {
      sessionId: ctx.sessionId,
      tool: request.tool,
      category: escalate ? "browser_secret" : verdict.category,
      reason: escalate ? `in your own Chrome: ${verdict.reason}` : verdict.reason,
      preview: buildBrowserActionPreview(
        request,
        element,
        host,
        verdict.category === "browser_secret",
      ),
      ...(host !== null ? { affectedResources: [host] } : {}),
    },
    ctx.signal,
  );
  return null;
}
