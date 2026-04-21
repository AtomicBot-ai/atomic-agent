export type LogLevel = "debug" | "info" | "warn" | "error";

export type BrowserChannel = "chrome" | "msedge" | "chromium";

/**
 * Full runtime config assembled from the user config file (6 user-facing
 * keys) plus environment variables (bootstrap paths, browser, llama
 * timeouts, etc.). All consumers outside `src/config/` depend only on
 * this shape.
 */
export interface AtomicAgentConfig {
  llama: {
    url: string;
    apiKey: string | null;
    healthPath: string;
    completionPath: string;
    healthTimeoutMs: number;
    requestTimeoutMs: number;
    healthRetries: number;
    healthRetryBackoffMs: number;
    defaultSlotId: number;
  };
  paths: {
    stateDir: string;
    sessionsDbFile: string;
    grammarsDir: string;
    browserProfileDir: string;
    globalSkillsDir: string;
    projectSkillsDirName: string;
    userConfigFile: string;
  };
  agent: {
    tokenBudget: number;
    maxSteps: number;
    toolTimeoutMs: number;
    approvalRequired: boolean;
    stablePrefixHashSalt: string;
  };
  browser: {
    channel: BrowserChannel;
    headless: boolean;
    cdpUrl: string | null;
    launchTimeoutMs: number;
  };
  skills: {
    catalogTokenBudget: number;
  };
  log: {
    level: LogLevel;
  };
}

/**
 * The 6 user-facing keys that live in `<stateDir>/config.json`. The file
 * format is versioned; bump `USER_CONFIG_VERSION` on breaking schema
 * changes and add a migration step in `parseUserConfigFile`.
 */
export interface UserConfigFile {
  version: typeof USER_CONFIG_VERSION;
  llama: { url: string };
  log: { level: LogLevel };
  agent: {
    tokenBudget: number;
    maxSteps: number;
    toolTimeoutMs: number;
    approvalRequired: boolean;
  };
}

export const USER_CONFIG_VERSION = 1 as const;

export const USER_CONFIG_DEFAULTS: UserConfigFile = {
  version: USER_CONFIG_VERSION,
  llama: { url: "http://127.0.0.1:8080" },
  log: { level: "info" },
  agent: {
    tokenBudget: 3000,
    maxSteps: 25,
    toolTimeoutMs: 60_000,
    approvalRequired: true,
  },
};

/** Non-user env-based defaults (not part of the user config file). */
export const ENV_DEFAULTS = {
  STATE_DIR: "~/.atomic-agent",
  HEALTH_TIMEOUT_MS: 3000,
  REQUEST_TIMEOUT_MS: 120_000,
  HEALTH_RETRIES: 5,
  HEALTH_BACKOFF_MS: 500,
  DEFAULT_SLOT_ID: 0,
  STABLE_PREFIX_SALT: "atomic-agent-v1",
  BROWSER_CHANNEL: "chrome" as BrowserChannel,
  BROWSER_HEADLESS: false,
  BROWSER_LAUNCH_TIMEOUT_MS: 30_000,
  SKILLS_CATALOG_BUDGET: 512,
  PROJECT_SKILLS_DIR: ".atomic-agent/skills",
  USER_CONFIG_FILE_NAME: "config.json",
};

export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`invalid config: ${field}: ${reason}`);
    this.name = "ConfigValidationError";
  }
}

export function parseLogLevel(raw: unknown, field: string): LogLevel {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of debug|info|warn|error, got ${JSON.stringify(raw)}`,
  );
}

export function parseBrowserChannel(raw: unknown, field: string): BrowserChannel {
  if (raw === "chrome" || raw === "msedge" || raw === "chromium") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of chrome|msedge|chromium, got ${JSON.stringify(raw)}`,
  );
}

export function parsePositiveInt(raw: unknown, field: string): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : NaN;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(
      field,
      `expected positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function parseBool(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lc = raw.toLowerCase();
    if (["1", "true", "yes", "on"].includes(lc)) return true;
    if (["0", "false", "no", "off"].includes(lc)) return false;
  }
  throw new ConfigValidationError(
    field,
    `expected boolean, got ${JSON.stringify(raw)}`,
  );
}

export function parseNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ConfigValidationError(
    field,
    `expected non-empty string, got ${JSON.stringify(raw)}`,
  );
}

export function parseUrl(raw: unknown, field: string): string {
  const str = parseNonEmptyString(raw, field);
  try {
    new URL(str);
    return str;
  } catch {
    throw new ConfigValidationError(field, `expected valid URL, got ${JSON.stringify(raw)}`);
  }
}

/**
 * Validate and normalise a raw JSON payload into a `UserConfigFile`.
 * Missing sub-keys are filled with defaults — this lets us add new
 * fields without breaking existing installations. Unknown top-level
 * keys are preserved silently (forward compat).
 */
export function parseUserConfigFile(raw: unknown): UserConfigFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("<root>", "expected JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version ?? USER_CONFIG_VERSION;
  if (version !== USER_CONFIG_VERSION) {
    throw new ConfigValidationError(
      "version",
      `unsupported config version ${JSON.stringify(version)}; expected ${USER_CONFIG_VERSION}`,
    );
  }

  const llama = (obj.llama as Record<string, unknown> | undefined) ?? {};
  const log = (obj.log as Record<string, unknown> | undefined) ?? {};
  const agent = (obj.agent as Record<string, unknown> | undefined) ?? {};

  return {
    version: USER_CONFIG_VERSION,
    llama: {
      url: parseUrl(llama.url ?? USER_CONFIG_DEFAULTS.llama.url, "llama.url"),
    },
    log: {
      level: parseLogLevel(log.level ?? USER_CONFIG_DEFAULTS.log.level, "log.level"),
    },
    agent: {
      tokenBudget: parsePositiveInt(
        agent.tokenBudget ?? USER_CONFIG_DEFAULTS.agent.tokenBudget,
        "agent.tokenBudget",
      ),
      maxSteps: parsePositiveInt(
        agent.maxSteps ?? USER_CONFIG_DEFAULTS.agent.maxSteps,
        "agent.maxSteps",
      ),
      toolTimeoutMs: parsePositiveInt(
        agent.toolTimeoutMs ?? USER_CONFIG_DEFAULTS.agent.toolTimeoutMs,
        "agent.toolTimeoutMs",
      ),
      approvalRequired: parseBool(
        agent.approvalRequired ?? USER_CONFIG_DEFAULTS.agent.approvalRequired,
        "agent.approvalRequired",
      ),
    },
  };
}
