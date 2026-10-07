import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parsePositiveInt } from "./config-primitives.js";
import { parseStringArrayOrNull } from "./config-values.js";

/**
 * When to require approval for outbound HTTP calls via `os.http.request`.
 *  - `never`:   trust the LLM blindly (not recommended outside sandboxes).
 *  - `writes`:  GET + HEAD bypass approval; anything with a body (POST…) needs it.
 *  - `always`:  every call goes through the approval gate.
 */
export type HttpApprovalMode = "never" | "writes" | "always";

export interface RuntimeHttpConfig {
  enabled: boolean;
  approvalMode: HttpApprovalMode;
  hostAllowlist: string[] | null;
  maxResponseBytes: number;
  defaultTimeoutMs: number;
}

export interface UserHttpConfig {
  enabled: boolean;
  approvalMode: HttpApprovalMode;
  hostAllowlist: string[] | null;
  maxResponseBytes: number;
  defaultTimeoutMs: number;
}

export function parseHttpApprovalMode(
  raw: unknown,
  field: string,
): HttpApprovalMode {
  if (raw === "never" || raw === "writes" || raw === "always") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of never|writes|always, got ${JSON.stringify(raw)}`,
  );
}

/**
 * v25 migration: outbound HTTP POST no longer requires approval by default.
 * The old default `"writes"` (POST asks) is rewritten to `"never"` on any
 * config older than v25, and a missing value adopts the new `"never"` default.
 * Users who explicitly tightened to `"always"` — or already chose `"never"` —
 * are preserved. From v25 onward the on-disk value is respected verbatim.
 */
function resolveHttpApprovalMode(
  inputVersion: number,
  raw: unknown,
  field: string,
  readDefaults: () => UserHttpConfig,
): HttpApprovalMode {
  if (
    inputVersion < 25 &&
    (raw === undefined || raw === null || raw === "writes")
  ) {
    return "never";
  }
  return parseHttpApprovalMode(
    raw ?? readDefaults().approvalMode,
    field,
  );
}

export function createHttpDefaults(): UserHttpConfig {
  return {
    enabled: true,
    approvalMode: "never",
    hostAllowlist: null,
    maxResponseBytes: 1_048_576,
    defaultTimeoutMs: 30_000,
  };
}

export function parseHttpConfig(
  raw: Record<string, unknown>,
  inputVersion: number,
  readDefaults: () => UserHttpConfig,
): UserHttpConfig {
  return {
    enabled: parseBool(
      raw.enabled ?? readDefaults().enabled,
      "http.enabled",
    ),
    approvalMode: resolveHttpApprovalMode(
      inputVersion,
      raw.approvalMode,
      "http.approvalMode",
      readDefaults,
    ),
    hostAllowlist: parseStringArrayOrNull(
      raw.hostAllowlist ?? readDefaults().hostAllowlist,
      "http.hostAllowlist",
    ),
    maxResponseBytes: parsePositiveInt(
      raw.maxResponseBytes ?? readDefaults().maxResponseBytes,
      "http.maxResponseBytes",
    ),
    defaultTimeoutMs: parsePositiveInt(
      raw.defaultTimeoutMs ?? readDefaults().defaultTimeoutMs,
      "http.defaultTimeoutMs",
    ),
  };
}
