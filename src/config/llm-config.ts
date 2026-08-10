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
};

export type UserLlmFileConfig = {
  activeTextProvider: string;
  activeEmbeddingProvider: string;
  toolTransport: UserLlmToolTransport;
  providers: UserLlmProviderEntry[];
};

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_KINDS = new Set([
  "llama-server",
  "openai-compatible",
  "openrouter",
  "aimlapi",
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
  };
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
  return {
    activeTextProvider,
    activeEmbeddingProvider,
    toolTransport: toolTransportRaw,
    providers,
  };
}
