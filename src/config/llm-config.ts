import { ConfigValidationError } from "./config-validation-error.js";
import { SUBSCRIPTION_CLI_KIND } from "./provider-auth-mode.js";

export type UserLlmToolTransport = "auto" | "grammar" | "native_tools";

/** Vendor CLIs a `subscription-cli` provider knows how to drive. */
export const SUBSCRIPTION_CLIS = ["claude", "codex"] as const;
export type SubscriptionCliName = (typeof SUBSCRIPTION_CLIS)[number];

/**
 * Settings for a provider backed by an already-signed-in vendor CLI.
 * The CLI authenticates itself from its own session, so there is no
 * `apiKey` / `apiKeyEnvVar` anywhere in this block.
 */
export type UserSubscriptionCliOptions = {
  /** Which CLI to drive. Required when `kind` is `subscription-cli`. */
  cli: SubscriptionCliName;
  /** Absolute path to the binary. Omit to resolve it from `PATH`. */
  binPath?: string;
  /**
   * Extra argv appended verbatim to every invocation. The escape hatch
   * for flags we do not model (`--effort high`) and for correcting a
   * vendor CLI whose interface moved, without waiting for a release.
   */
  extraArgs?: string[];
  /** Opt out of the streaming path and always buffer. */
  streaming?: boolean;
  /** Passed through as the CLI's own spend ceiling where it has one. */
  maxBudgetUsd?: number;
};

export type UserLlmProviderEntry = {
  id: string;
  kind: string;
  url?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * Env var holding this entry's API key. Set for known-service presets
   * so each service keeps its own key (`GROQ_API_KEY`, `NOUS_API_KEY`,
   * ...). When present it is authoritative: entries without it fall
   * back to the per-kind defaults in `resolveLlmProviderApiKey`.
   */
  apiKeyEnvVar?: string;
  defaultChatModel?: string;
  defaultEmbeddingModel?: string;
  headers?: Record<string, string>;
  supportsTools?: boolean;
  supportsVision?: boolean;
  requestTimeoutMs?: number;
  /**
   * Vendor-specific fields merged into the OpenAI-compatible chat body
   * for `openai-compatible` / `qwen-openai-compatible` providers. Lets a
   * deployment reach vendor extensions outside the OpenAI schema, e.g.
   * Alibaba Model Studio thinking control:
   *
   * ```json
   * { "chat_template_kwargs": { "enable_thinking": false } }
   * ```
   *
   * Reserved keys (`model`, `messages`, `stream`, `tools`) are re-applied
   * after the merge and cannot be overridden from config.
   */
  extraBody?: Record<string, unknown>;
  /** Present only on `subscription-cli` entries; see the type above. */
  subscriptionCli?: UserSubscriptionCliOptions;
};

export type UserLlmFallbackConfig = {
  chain?: string[];
  appendLocal?: boolean;
  failureThreshold?: number;
  cooldownMs?: number[];
  probeThrottleMs?: number;
  failureWindowMs?: number;
};

export type UserLlmFileConfig = {
  activeTextProvider: string;
  activeEmbeddingProvider: string;
  toolTransport: UserLlmToolTransport;
  providers: UserLlmProviderEntry[];
  fallback?: UserLlmFallbackConfig;
};

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_KINDS = new Set([
  "llama-server",
  "openai-compatible",
  "qwen-openai-compatible",
  "openrouter",
  "aimlapi",
  "gemini",
  SUBSCRIPTION_CLI_KIND,
]);

function parseProviderId(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !PROVIDER_ID_RE.test(raw)) {
    throw new ConfigValidationError(
      field,
      `expected kebab-case id matching ${PROVIDER_ID_RE.source}`,
    );
  }
  return raw;
}

function parseOptionalString(
  raw: unknown,
  field: string,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigValidationError(field, "expected non-empty string");
  }
  return raw;
}

function parseOptionalHeaders(
  raw: unknown,
  field: string,
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ConfigValidationError(`${field}.${key}`, "expected string");
    }
    out[key] = value;
  }
  return out;
}

export function parseLlmProviderEntry(
  raw: unknown,
  field: string,
): UserLlmProviderEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const id = parseProviderId(obj.id, `${field}.id`);
  const kind = parseOptionalString(obj.kind, `${field}.kind`);
  if (!kind || !PROVIDER_KINDS.has(kind)) {
    throw new ConfigValidationError(
      `${field}.kind`,
      `expected one of ${[...PROVIDER_KINDS].join(", ")}`,
    );
  }
  const subscriptionCli = parseSubscriptionCliOptions(
    obj.subscriptionCli,
    `${field}.subscriptionCli`,
  );
  // A `subscription-cli` entry without a `cli` has no binary to drive, so
  // fail at load rather than at the first inference an hour into a run.
  if (kind === SUBSCRIPTION_CLI_KIND && !subscriptionCli) {
    throw new ConfigValidationError(
      `${field}.subscriptionCli`,
      `required when kind is ${SUBSCRIPTION_CLI_KIND}`,
    );
  }
  return {
    id,
    kind,
    url: parseOptionalString(obj.url, `${field}.url`),
    apiKey: parseOptionalString(obj.apiKey, `${field}.apiKey`),
    model: parseOptionalString(obj.model, `${field}.model`),
    baseUrl: parseOptionalString(obj.baseUrl, `${field}.baseUrl`),
    apiKeyEnvVar: parseOptionalString(obj.apiKeyEnvVar, `${field}.apiKeyEnvVar`),
    defaultChatModel: parseOptionalString(
      obj.defaultChatModel,
      `${field}.defaultChatModel`,
    ),
    defaultEmbeddingModel: parseOptionalString(
      obj.defaultEmbeddingModel,
      `${field}.defaultEmbeddingModel`,
    ),
    headers: parseOptionalHeaders(obj.headers, `${field}.headers`),
    supportsTools:
      obj.supportsTools === undefined
        ? undefined
        : typeof obj.supportsTools === "boolean"
          ? obj.supportsTools
          : (() => {
              throw new ConfigValidationError(
                `${field}.supportsTools`,
                "expected boolean",
              );
            })(),
    supportsVision:
      obj.supportsVision === undefined
        ? undefined
        : typeof obj.supportsVision === "boolean"
          ? obj.supportsVision
          : (() => {
              throw new ConfigValidationError(
                `${field}.supportsVision`,
                "expected boolean",
              );
            })(),
    requestTimeoutMs:
      obj.requestTimeoutMs === undefined
        ? undefined
        : typeof obj.requestTimeoutMs === "number" &&
            Number.isFinite(obj.requestTimeoutMs) &&
            obj.requestTimeoutMs > 0
          ? Math.floor(obj.requestTimeoutMs)
          : (() => {
              throw new ConfigValidationError(
                `${field}.requestTimeoutMs`,
                "expected positive number",
              );
            })(),
    extraBody: parseOptionalExtraBody(obj.extraBody, `${field}.extraBody`),
    subscriptionCli,
  };
}

function parseSubscriptionCliOptions(
  raw: unknown,
  field: string,
): UserSubscriptionCliOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const cli = obj.cli;
  if (
    typeof cli !== "string" ||
    !(SUBSCRIPTION_CLIS as readonly string[]).includes(cli)
  ) {
    throw new ConfigValidationError(
      `${field}.cli`,
      `expected one of ${SUBSCRIPTION_CLIS.join(", ")}`,
    );
  }
  const out: UserSubscriptionCliOptions = { cli: cli as SubscriptionCliName };
  const binPath = parseOptionalString(obj.binPath, `${field}.binPath`);
  if (binPath !== undefined) out.binPath = binPath;
  if (obj.extraArgs !== undefined && obj.extraArgs !== null) {
    if (!Array.isArray(obj.extraArgs)) {
      throw new ConfigValidationError(
        `${field}.extraArgs`,
        "expected array of strings",
      );
    }
    out.extraArgs = obj.extraArgs.map((value, i) => {
      if (typeof value !== "string") {
        throw new ConfigValidationError(
          `${field}.extraArgs[${i}]`,
          "expected string",
        );
      }
      return value;
    });
  }
  if (obj.streaming !== undefined && obj.streaming !== null) {
    if (typeof obj.streaming !== "boolean") {
      throw new ConfigValidationError(`${field}.streaming`, "expected boolean");
    }
    out.streaming = obj.streaming;
  }
  if (obj.maxBudgetUsd !== undefined && obj.maxBudgetUsd !== null) {
    if (
      typeof obj.maxBudgetUsd !== "number" ||
      !Number.isFinite(obj.maxBudgetUsd) ||
      obj.maxBudgetUsd <= 0
    ) {
      throw new ConfigValidationError(
        `${field}.maxBudgetUsd`,
        "expected positive number",
      );
    }
    out.maxBudgetUsd = obj.maxBudgetUsd;
  }
  return out;
}

function parseOptionalExtraBody(
  raw: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  return { ...(raw as Record<string, unknown>) };
}

export function parseLlmProviders(
  raw: unknown,
  field: string,
): UserLlmProviderEntry[] {
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected array");
  }
  const seen = new Set<string>();
  const out: UserLlmProviderEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = parseLlmProviderEntry(raw[i], `${field}[${i}]`);
    if (seen.has(entry.id)) {
      throw new ConfigValidationError(
        `${field}[${i}].id`,
        `duplicate provider id ${JSON.stringify(entry.id)}`,
      );
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function parsePositiveInt(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new ConfigValidationError(field, "expected a positive integer");
  }
  return raw;
}

function parseCooldownLadder(raw: unknown, field: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(
      field,
      "expected a non-empty array of positive integers (ms)",
    );
  }
  const ladder = raw.map((v, i) => parsePositiveInt(v, `${field}[${i}]`));
  // The breaker walks this ladder by step index, so it must be
  // non-decreasing to actually escalate. A decreasing entry (e.g.
  // [300000, 1000]) would make the second cooldown SHORTER than the
  // first — the opposite of the documented "escalating ladder". Reject
  // it at parse time rather than silently serving a shrinking cooldown.
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i]! < ladder[i - 1]!) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `cooldown ladder must be non-decreasing (${ladder[i]} < ${ladder[i - 1]} at the previous step)`,
      );
    }
  }
  return ladder;
}

export function parseLlmFallbackConfig(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
): UserLlmFallbackConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserLlmFallbackConfig = {};

  if (obj.chain !== undefined) {
    if (!Array.isArray(obj.chain)) {
      throw new ConfigValidationError(`${field}.chain`, "expected array of provider ids");
    }
    const chain = obj.chain.map((v, i) =>
      parseProviderId(v, `${field}.chain[${i}]`),
    );
    for (let i = 0; i < chain.length; i++) {
      if (!providerIds.has(chain[i]!)) {
        throw new ConfigValidationError(
          `${field}.chain[${i}]`,
          `unknown provider id ${JSON.stringify(chain[i])}`,
        );
      }
    }
    out.chain = chain;
  }

  if (obj.appendLocal !== undefined) {
    if (typeof obj.appendLocal !== "boolean") {
      throw new ConfigValidationError(`${field}.appendLocal`, "expected boolean");
    }
    out.appendLocal = obj.appendLocal;
  }
  if (obj.failureThreshold !== undefined) {
    out.failureThreshold = parsePositiveInt(
      obj.failureThreshold,
      `${field}.failureThreshold`,
    );
  }
  if (obj.cooldownMs !== undefined) {
    out.cooldownMs = parseCooldownLadder(obj.cooldownMs, `${field}.cooldownMs`);
  }
  if (obj.probeThrottleMs !== undefined) {
    out.probeThrottleMs = parsePositiveInt(
      obj.probeThrottleMs,
      `${field}.probeThrottleMs`,
    );
  }
  if (obj.failureWindowMs !== undefined) {
    out.failureWindowMs = parsePositiveInt(
      obj.failureWindowMs,
      `${field}.failureWindowMs`,
    );
  }
  return out;
}

export function parseUserLlmFileConfig(
  raw: unknown,
  defaults: UserLlmFileConfig,
): UserLlmFileConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("llm", "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const providers = parseLlmProviders(
    obj.providers ?? defaults.providers,
    "llm.providers",
  );
  const activeTextProvider = parseProviderId(
    obj.activeTextProvider ?? defaults.activeTextProvider,
    "llm.activeTextProvider",
  );
  const activeEmbeddingProvider = parseProviderId(
    obj.activeEmbeddingProvider ?? defaults.activeEmbeddingProvider,
    "llm.activeEmbeddingProvider",
  );
  if (!providers.some((p) => p.id === activeTextProvider)) {
    throw new ConfigValidationError(
      "llm.activeTextProvider",
      `unknown provider id ${JSON.stringify(activeTextProvider)}`,
    );
  }
  if (!providers.some((p) => p.id === activeEmbeddingProvider)) {
    throw new ConfigValidationError(
      "llm.activeEmbeddingProvider",
      `unknown provider id ${JSON.stringify(activeEmbeddingProvider)}`,
    );
  }
  const toolTransportRaw = obj.toolTransport ?? defaults.toolTransport;
  if (
    toolTransportRaw !== "auto" &&
    toolTransportRaw !== "grammar" &&
    toolTransportRaw !== "native_tools"
  ) {
    throw new ConfigValidationError(
      "llm.toolTransport",
      "expected auto|grammar|native_tools",
    );
  }
  const fallback =
    obj.fallback === undefined || obj.fallback === null
      ? undefined
      : parseLlmFallbackConfig(
          obj.fallback,
          new Set(providers.map((p) => p.id)),
          "llm.fallback",
        );

  return {
    activeTextProvider,
    activeEmbeddingProvider,
    toolTransport: toolTransportRaw,
    providers,
    ...(fallback ? { fallback } : {}),
  };
}
