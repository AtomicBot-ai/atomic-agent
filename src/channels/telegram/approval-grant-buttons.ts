import {
  sessionGrantSummary,
  type SessionGrantOffer,
} from "../approval-session-grants.js";
import { fitButtonText } from "./button-text.js";

/**
 * Telegram's wire form of the shared session grants (GitHub #230). What
 * may be granted, the button words and the scope a click asks for live
 * in `../approval-session-grants.ts`, shared with Discord, Slack and
 * Microsoft Teams (ATO-2509); this file only builds Telegram's rows.
 */
export {
  sessionGrantOffer,
  sessionGrantScope,
  type SessionGrantOffer,
} from "../approval-session-grants.js";

/**
 * One row per offered grant, under Approve / Deny and above "Allow
 * always": `appr:<id>:s` for the kind, `appr:<id>:a` for the shape.
 * With a UUID approval id that is 43 bytes, inside Telegram's 64-byte
 * `callback_data` limit.
 */
export function sessionGrantRows(
  prefix: string,
  approvalId: string,
  offer: SessionGrantOffer | null,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (offer?.category !== undefined) {
    rows.push([
      {
        // Cut in the middle so the scope words stay (ATO-2757), not the
        // shared end-cut label.
        text: fitButtonText(`Allow ${offer.category} this session`),
        callback_data: `${prefix}${approvalId}:s`,
      },
    ]);
  }
  if (offer?.shape !== undefined) {
    rows.push([
      {
        text: fitButtonText(`Allow all ${offer.shape} this session`),
        callback_data: `${prefix}${approvalId}:a`,
      },
    ]);
  }
  return rows;
}

/** The text the prompt is edited to once a session grant is chosen. */
export function sessionGrantFinalText(
  scope: "category" | "shape",
  offer: SessionGrantOffer,
): string {
  return `✅ approved · allowed this session: ${sessionGrantSummary(scope, offer)}`;
}
