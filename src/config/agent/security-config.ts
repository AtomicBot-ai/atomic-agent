import { ConfigValidationError } from "../config-validation-error.js";
import { coerceFloatLike } from "../config-primitives.js";

/**
 * `agent.security` (ATO-2505): how sure an argument check must be before
 * it asks at every approval level, bypass included. Additive and
 * unversioned: a file without it reads the default.
 */
export interface AgentSecurityConfig {
  /**
   * The confidence at or above which an argument finding (a credential read, an encoded command, a secret in an HTTP body) asks at every approval level, bypass included. Range 0.5 to 1, default 0.7. Below it a finding asks as an ordinary dangerous action and goes quiet at full trust. Read live.
   */
  argScanThreshold: number;
}

/** Same number as `ASK_EVERY_LEVEL_CONFIDENCE` in the shell guard. */
export const DEFAULT_ARG_SCAN_THRESHOLD = 0.7;
export const MIN_ARG_SCAN_THRESHOLD = 0.5;

export function createAgentSecurityDefaults(): AgentSecurityConfig {
  return { argScanThreshold: DEFAULT_ARG_SCAN_THRESHOLD };
}

/** Absent keys keep `defaults`; a value outside 0.5..1 is an error. */
export function parseAgentSecurityConfig(
  raw: unknown,
  defaults: AgentSecurityConfig = createAgentSecurityDefaults(),
): AgentSecurityConfig {
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("agent.security", `expected an object, got ${JSON.stringify(raw)}`);
  }
  const value = (raw as { argScanThreshold?: unknown }).argScanThreshold;
  if (value === undefined || value === null) return { ...defaults };
  const threshold = coerceFloatLike(value);
  if (!Number.isFinite(threshold) || threshold < MIN_ARG_SCAN_THRESHOLD || threshold > 1) {
    throw new ConfigValidationError(
      "agent.security.argScanThreshold",
      `expected number in [${MIN_ARG_SCAN_THRESHOLD}, 1], got ${JSON.stringify(value)}`,
    );
  }
  return { argScanThreshold: threshold };
}
