import { ConfigValidationError } from "./config-validation-error.js";

export type UserLlmToolTransport = "auto" | "grammar" | "native_tools";

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
   * Prompt-caching policy for this provider. Declared in the config
   * schema and on `LlmProviderConfigEntry`; no provider reads it yet,
   * so today it only has to survive the round-trip through config.
   */
  promptCache?: "auto" | "off" | "explicit-markers";
  /**
   * Vendor routing preferences (e.g. OpenRouter's `provider` block).
   * Same status as `promptCache`: carried through config, not yet read
   * by any provider.
   */
  providerPreferences?: Record<string, unknown>;
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
  /**
   * Hand-written model metadata for this provider. `resolveModel`
   * reads it as its highest-priority source (userModels > bundled
   * catalog > defaults), so it is the documented way to teach the
   * runtime about a model the bundled catalog does not know: context
   * window, capabilities and pricing.
   */
  userModels?: ReadonlyArray<UserModelEntry>;
};

/**
 * One hand-configured model on a provider entry. Mirrors
 * `UserModelConfigEntry` in the provider registry — the shape
 * `resolveModel` merges over the bundled catalog.
 *
 * Note `supportsTools` here is a support *level*, not the boolean of
 * the same name on the provider entry: a model can advertise strict or
 * parallel tool calling independently of whether the transport does.
 */
export type UserModelEntry = {
  id: string;
  kind: "chat" | "embedding";
  contextWindow?: number;
  dim?: number;
  supportsVision?: boolean;
  supportsTools?: "none" | "basic" | "parallel" | "strict";
  supportsPromptCache?: boolean;
  reasoningFormat?:
    | "none"
    | "delta_reasoning"
    | "delta_thinking"
    | "delta_reasoning_content";
  pricing?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
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
    promptCache: parseOptionalEnum<
      NonNullable<UserLlmProviderEntry["promptCache"]>
    >(obj.promptCache, `${field}.promptCache`, PROMPT_CACHE_MODES),
    providerPreferences: parseOptionalPlainObject(
      obj.providerPreferences,
      `${field}.providerPreferences`,
    ),
    extraBody: parseOptionalPlainObject(obj.extraBody, `${field}.extraBody`),
    userModels: parseOptionalUserModels(obj.userModels, `${field}.userModels`),
  };
}

function parseOptionalPlainObject(
  raw: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  return { ...(raw as Record<string, unknown>) };
}

const PROMPT_CACHE_MODES = new Set(["auto", "off", "explicit-markers"]);
const TOOLS_SUPPORT_LEVELS = new Set(["none", "basic", "parallel", "strict"]);
const REASONING_FORMATS = new Set([
  "none",
  "delta_reasoning",
  "delta_thinking",
  "delta_reasoning_content",
]);

function parseOptionalBoolean(
  raw: unknown,
  field: string,
): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new ConfigValidationError(field, "expected boolean");
  }
  return raw;
}

function parseOptionalEnum<T extends string>(
  raw: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !allowed.has(raw)) {
    throw new ConfigValidationError(field, `expected ${[...allowed].join("|")}`);
  }
  return raw as T;
}

/**
 * Prices are per-token rates, so 0 is legal (free tiers) but negative
 * or non-finite is not — a NaN rate would poison every cost estimate
 * downstream rather than fail loudly.
 */
function parseRate(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new ConfigValidationError(field, "expected a non-negative number");
  }
  return raw;
}

function parseUserModelPricing(
  raw: unknown,
  field: string,
): UserModelEntry["pricing"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const pricing: NonNullable<UserModelEntry["pricing"]> = {
    input: parseRate(obj.input, `${field}.input`),
    output: parseRate(obj.output, `${field}.output`),
  };
  if (obj.cacheRead !== undefined && obj.cacheRead !== null) {
    pricing.cacheRead = parseRate(obj.cacheRead, `${field}.cacheRead`);
  }
  if (obj.cacheWrite !== undefined && obj.cacheWrite !== null) {
    pricing.cacheWrite = parseRate(obj.cacheWrite, `${field}.cacheWrite`);
  }
  return pricing;
}

function parseUserModelEntry(raw: unknown, field: string): UserModelEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new ConfigValidationError(`${field}.id`, "expected non-empty string");
  }
  if (obj.kind !== "chat" && obj.kind !== "embedding") {
    throw new ConfigValidationError(`${field}.kind`, "expected chat|embedding");
  }
  return {
    id: obj.id,
    kind: obj.kind,
    contextWindow:
      obj.contextWindow === undefined || obj.contextWindow === null
        ? undefined
        : parsePositiveInt(obj.contextWindow, `${field}.contextWindow`),
    dim:
      obj.dim === undefined || obj.dim === null
        ? undefined
        : parsePositiveInt(obj.dim, `${field}.dim`),
    supportsVision: parseOptionalBoolean(
      obj.supportsVision,
      `${field}.supportsVision`,
    ),
    supportsTools: parseOptionalEnum<
      NonNullable<UserModelEntry["supportsTools"]>
    >(obj.supportsTools, `${field}.supportsTools`, TOOLS_SUPPORT_LEVELS),
    supportsPromptCache: parseOptionalBoolean(
      obj.supportsPromptCache,
      `${field}.supportsPromptCache`,
    ),
    reasoningFormat: parseOptionalEnum<
      NonNullable<UserModelEntry["reasoningFormat"]>
    >(obj.reasoningFormat, `${field}.reasoningFormat`, REASONING_FORMATS),
    pricing: parseUserModelPricing(obj.pricing, `${field}.pricing`),
  };
}

function parseOptionalUserModels(
  raw: unknown,
  field: string,
): UserModelEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected array");
  }
  // `resolveModel` looks a model up by id with `.find`, so a duplicate
  // id would silently shadow the later row. Reject it at parse time
  // instead of serving whichever copy happens to come first.
  const seen = new Set<string>();
  const out: UserModelEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = parseUserModelEntry(raw[i], `${field}[${i}]`);
    if (seen.has(entry.id)) {
      throw new ConfigValidationError(
        `${field}[${i}].id`,
        `duplicate model id ${JSON.stringify(entry.id)}`,
      );
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
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
