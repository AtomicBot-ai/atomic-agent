/**
 * The admin policy file (ATO-587): rules an organisation sets for every
 * agent on a machine. The format follows OpenWork / OpenCode agent
 * permissions (ordered `action` + `resource` glob + `effect`, the last
 * match wins) with one change: a matching `deny` always wins, wherever
 * it sits. `mcpAllowlist` follows Goose's `GOOSE_ALLOWLIST`, including
 * its soft `warnOnly` mode.
 *
 * Parsed by hand like the rest of the config: the repo validates JSON
 * files with small parsers, not a schema library.
 */

export const POLICY_ACTIONS = ["shell", "edit", "webfetch", "websearch", "skill", "mcp"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_EFFECTS = ["allow", "ask", "deny"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export interface PolicyRule {
  action: PolicyAction;
  /** Glob: `*` matches any run of characters (slashes too), `?` one character. */
  resource: string;
  effect: PolicyEffect;
  /** Shown in a denial so a person knows why ("ask IT before pushing"). */
  note?: string;
}

export interface McpAllowlist {
  /** Globs matched against a server's name, its URL, or its stdio command. */
  servers: string[];
  /** Log a server that is not listed instead of refusing it (Goose's soft mode). */
  warnOnly: boolean;
}

export interface PolicyFile {
  version: 1;
  rules: PolicyRule[];
  mcpAllowlist?: McpAllowlist;
}

export class PolicyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new PolicyFormatError(`${where} must be one of ${allowed.join(", ")}`);
}

function parseRule(entry: unknown, index: number): PolicyRule {
  const where = `rules[${index}]`;
  if (!isRecord(entry)) throw new PolicyFormatError(`${where} must be an object`);
  const action = oneOf(entry.action, POLICY_ACTIONS, `${where}.action`);
  const effect = oneOf(entry.effect, POLICY_EFFECTS, `${where}.effect`);
  const resource = entry.resource ?? "*";
  if (typeof resource !== "string" || resource.length === 0) {
    throw new PolicyFormatError(`${where}.resource must be a non-empty string`);
  }
  const rule: PolicyRule = { action, resource, effect };
  if (entry.note !== undefined) {
    if (typeof entry.note !== "string") throw new PolicyFormatError(`${where}.note must be a string`);
    rule.note = entry.note;
  }
  return rule;
}

function parseAllowlist(value: unknown): McpAllowlist {
  // A bare array is accepted as the list of servers.
  const raw = Array.isArray(value) ? { servers: value } : value;
  if (!isRecord(raw)) throw new PolicyFormatError("mcpAllowlist must be an object or an array");
  const servers = raw.servers;
  if (!Array.isArray(servers) || !servers.every((s) => typeof s === "string" && s.length > 0)) {
    throw new PolicyFormatError("mcpAllowlist.servers must be an array of non-empty strings");
  }
  const warnOnly = raw.warnOnly ?? false;
  if (typeof warnOnly !== "boolean") throw new PolicyFormatError("mcpAllowlist.warnOnly must be true or false");
  return { servers: [...servers] as string[], warnOnly };
}

/** Validate a parsed policy document. Throws `PolicyFormatError` with the first problem. */
export function parsePolicyFile(value: unknown): PolicyFile {
  if (!isRecord(value)) throw new PolicyFormatError("policy must be a JSON object");
  const version = value.version ?? 1;
  if (version !== 1) throw new PolicyFormatError(`unsupported policy version ${String(version)} (expected 1)`);
  const rules = value.rules ?? [];
  if (!Array.isArray(rules)) throw new PolicyFormatError("rules must be an array");
  const file: PolicyFile = { version: 1, rules: rules.map(parseRule) };
  if (value.mcpAllowlist !== undefined) file.mcpAllowlist = parseAllowlist(value.mcpAllowlist);
  return file;
}

/** Parse policy JSON text. Throws `PolicyFormatError` on bad JSON or a bad shape. */
export function parsePolicyText(text: string): PolicyFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new PolicyFormatError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsePolicyFile(value);
}
