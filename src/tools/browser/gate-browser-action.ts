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
  webHostOf,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
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
 * Runs after the stale-ref preflight and before the backend acts.
 * Returns a tool-error result when the page's host is blocked, throws
 * `ApprovalDeniedError` when the operator says no, and resolves `null`
 * when the action may go ahead.
 */
export async function gateBrowserAction(
  backend: BrowserBackend,
  dangerous: DangerousToolOptions,
  policy: BrowserDomainPolicy,
  request: BrowserActionRequest,
  ctx: Pick<ToolContext, "sessionId" | "signal">,
): Promise<CompressedToolResult | null> {
  const element = await describeSafely(backend, request.ref);
  const host = element ? webHostOf(element.pageUrl) : null;
  if (host !== null && checkBrowserHost(host, policy).kind === "blocked") {
    return compressToolResult({
      tool: request.tool,
      status: "error",
      output: blockedDomainMessage(request.tool, host),
      details: { ref: request.ref, host, reason: "blocked_domain" },
    });
  }
  const verdict = classifyBrowserAction(request.kind, element);
  if (verdict.category === null) return null;
  await requireApproval(
    dangerous,
    {
      sessionId: ctx.sessionId,
      tool: request.tool,
      category: verdict.category,
      reason: verdict.reason,
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
