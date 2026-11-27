import {
  sessionGrantLabels,
  type SessionGrantOffer,
} from "../approval-session-grants.js";
import type { DiscordComponentRow } from "./discord-api.js";

/** Discord button styles. */
const STYLE_DANGER = 4;
const STYLE_SECONDARY = 2;
const STYLE_PRIMARY = 1;

/** Discord caps a button label at 80 characters. */
const BUTTON_LABEL_MAX_CHARS = 80;

/** Prefix on every custom_id the approval bridge owns. */
export const CUSTOM_ID_PREFIX = "atomic:approve:";

/**
 * Two buttons, plus "Allow always" when `alwaysLabel` is given; ids
 * namespaced so foreign components never match. Offered session grants
 * get a second row, with Telegram's labels: `session` for the kind,
 * `shape` for the command shape (ATO-2509).
 */
export function buttonsFor(
  approvalId: string,
  alwaysLabel?: string,
  sessionGrants: SessionGrantOffer | null = null,
): DiscordComponentRow[] {
  const components: Array<DiscordComponentRow["components"][number]> = [
    {
      type: 2,
      style: STYLE_DANGER,
      label: "Approve",
      custom_id: `${CUSTOM_ID_PREFIX}yes:${approvalId}`,
    },
    {
      type: 2,
      style: STYLE_SECONDARY,
      label: "Deny",
      custom_id: `${CUSTOM_ID_PREFIX}no:${approvalId}`,
    },
  ];
  if (alwaysLabel !== undefined) {
    components.push({
      type: 2,
      style: STYLE_PRIMARY,
      label:
        alwaysLabel.length <= BUTTON_LABEL_MAX_CHARS
          ? alwaysLabel
          : `${alwaysLabel.slice(0, BUTTON_LABEL_MAX_CHARS - 1)}…`,
      custom_id: `${CUSTOM_ID_PREFIX}always:${approvalId}`,
    });
  }
  const rows: DiscordComponentRow[] = [{ type: 1, components }];
  const labels = sessionGrantLabels(sessionGrants);
  const offered: Array<[string, string | undefined]> = [
    ["session", labels.category],
    ["shape", labels.shape],
  ];
  const grants = offered
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([verb, label]) => ({
      type: 2 as const,
      style: STYLE_PRIMARY,
      label,
      custom_id: `${CUSTOM_ID_PREFIX}${verb}:${approvalId}`,
    }));
  if (grants.length > 0) rows.push({ type: 1, components: grants });
  return rows;
}
