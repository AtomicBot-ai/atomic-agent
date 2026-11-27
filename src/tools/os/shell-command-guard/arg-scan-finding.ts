import type { GuardVerdict } from "./guard-types.js";

/**
 * At or above this confidence a credential read or an encoded command
 * asks at every approval level, bypass included (ATO-2126). Below it the
 * finding is an ordinary `dangerous.*` verdict: it asks as
 * `shell_dangerous` and goes quiet only at full trust.
 *
 * Same shape as Goose's security scanner (`crates/goose/src/security/
 * scanner.rs`): every pattern finding carries a confidence and one
 * threshold decides which findings stop the call. This is the default;
 * `agent.security.argScanThreshold` (0.5..0.7, ATO-2505) lowers it live
 * through `ShellGuardPolicy.argScanThreshold`.
 */
export const ASK_EVERY_LEVEL_CONFIDENCE = 0.7;

/** One argument-pattern finding of the dangerous layer. */
export interface ArgScanFinding {
  id: string;
  reason: string;
  /** 0..1, see `GuardVerdict.confidence`. */
  confidence: number;
}

/**
 * The verdict for a finding: approval required, the confidence carried
 * along, and `askEveryLevel` when the confidence reaches the threshold.
 */
export function argScanVerdict(
  finding: ArgScanFinding,
  threshold: number = ASK_EVERY_LEVEL_CONFIDENCE,
): GuardVerdict {
  return {
    action: "approval_required",
    rule: finding.id,
    reason: finding.reason,
    confidence: finding.confidence,
    ...(finding.confidence >= threshold ? { askEveryLevel: true as const } : {}),
  };
}
