import type { ApprovalLevel } from "../../approval/approval-level.js";

/**
 * Reducer actions specific to the Privacy tab. The orchestrator and the
 * keyboard layer emit these; the reducer folds them into
 * `state.privacyPanel`. The `privacy_*` prefix lets the root reducer
 * narrow without a runtime tag dictionary.
 */
export type PrivacyAction =
  | {
      type: "privacy_synced";
      analyticsEnabled: boolean;
      approvalLevel: ApprovalLevel;
    }
  | { type: "privacy_action_started" }
  | { type: "privacy_action_settled"; message?: string; error?: string }
  | { type: "privacy_message_cleared" };

/** Narrow runtime guard used by the root reducer to dispatch. */
export function isPrivacyAction(action: {
  type: string;
}): action is PrivacyAction {
  return action.type.startsWith("privacy_");
}
