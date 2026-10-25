import type { ApprovalRequest } from "../approval/approval-gate.js";
import {
  isPreviewCut,
  pagePreview,
  type PreviewExcerptLimits,
} from "../approval/approval-preview.js";

/**
 * How much of a preview the approval prompt shows at once (ATO-434).
 * Enough for a typical multi-line script or a short diff while the
 * decision buttons stay on a laptop-sized terminal. The excerpt and
 * every page of the full view share it, so paging never pushes the
 * buttons further down than the excerpt already does.
 */
export const APPROVAL_PREVIEW_LIMITS: PreviewExcerptLimits = {
  maxLines: 20,
  maxChars: 1200,
};

/**
 * Whether the prompt's excerpt leaves part of the preview out, which is
 * exactly when the full view is offered (ATO-876). A preview that fits
 * has nothing more to show, so the key and the button stay off.
 */
export function approvalPreviewTruncated(request: ApprovalRequest): boolean {
  return (
    typeof request.preview === "string" &&
    request.preview.length > 0 &&
    isPreviewCut(request.preview, APPROVAL_PREVIEW_LIMITS)
  );
}

/** The whole preview, a page at a time, for the full view. */
export function approvalPreviewPages(request: ApprovalRequest): string[][] {
  if (!request.preview) return [];
  return pagePreview(request.preview, APPROVAL_PREVIEW_LIMITS);
}

/**
 * The page the full view moves to on the next press: from the excerpt
 * (`null`) to the first page, then page by page, and back to the
 * excerpt after the last one. A preview that is not cut has no full
 * view, so it stays on the excerpt.
 */
export function nextApprovalPreviewPage(
  request: ApprovalRequest,
  page: number | null,
): number | null {
  if (!approvalPreviewTruncated(request)) return null;
  const next = page === null ? 0 : page + 1;
  return next < approvalPreviewPages(request).length ? next : null;
}
