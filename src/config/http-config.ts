import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parsePositiveInt } from "./config-primitives.js";
import { parseStringArrayOrNull } from "./config-values.js";

/**
 * When to require approval for outbound HTTP calls via `os.http.request`.
 *  - `never`:   trust the LLM blindly (not recommended outside sandboxes).
 *  - `writes`:  GET + HEAD bypass approval; anything with a body (POST…) needs it.
 *               The default since v79. A GET can still carry data out in its
 *               URL (query string, path); this mode does not look inside it.
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
 * v79 migration: a request that sends data asks first again (ATO-760).
 *
 * v25 made `"never"` the default, so with no approval at all a model that
 * read a hostile page could POST the user's files or keys anywhere. Every
 * first run writes the full defaults and the v25 migration rewrote
 * `"writes"` to `"never"`, so a stored `"never"` in a file older than v79
 * is the schema's value, not a choice: it becomes `"writes"`. A missing
 * value takes the current default. `"always"` (and `"writes"`) are kept.
 * From v79 the on-disk value is respected verbatim, so an operator who
 * sets `http.approvalMode: "never"` again keeps it.
 */
function resolveHttpApprovalMode(
  inputVersion: number,
  raw: unknown,
  field: string,
  readDefaults: () => UserHttpConfig,
): HttpApprovalMode {
  if (inputVersion < 79 && raw === "never") return "writes";
  return parseHttpApprovalMode(
    raw ?? readDefaults().approvalMode,
    field,
  );
}

export function createHttpDefaults(): UserHttpConfig {
  return {
    enabled: true,
    approvalMode: "writes",
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
