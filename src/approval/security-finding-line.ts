import type { SecurityFinding } from "./approval-ledger.js";
import { cleanEgressLabel } from "./egress-scan.js";

/**
 * The card line for an argument check (ATO-2505, `ApprovalRequest.
 * securityFinding`): `security check: reads a credential file
 * (~/.ssh/id_rsa), 90% sure; asks in every mode`. `null` when the
 * request carries none. Plain text on one line (control characters
 * become spaces); each surface escapes it. Shared by the TUI, Telegram
 * and Discord; the desktop draws the same words.
 */
export function formatSecurityFindingLine(request: {
  securityFinding?: SecurityFinding;
  askEveryLevel?: true;
}): string | null {
  const finding = request.securityFinding;
  if (finding === undefined) return null;
  const sure = Math.round(Math.min(Math.max(finding.confidence, 0), 1) * 100);
  const every = request.askEveryLevel === true ? "; asks in every mode" : "";
  return `security check: ${cleanEgressLabel(finding.reason)}, ${sure}% sure${every}`;
}
