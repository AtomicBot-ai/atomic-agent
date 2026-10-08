import type {
  LocalLlmMode,
  LocalTemplateSetting,
  UserManagedLocalLlmConfig,
  LocalModelDownloadConfig,
  UserManagedEmbeddingLlmConfig,
  UserLocalModelsConfig,
} from "./local-models-types.js";
import { ConfigValidationError } from "../config-validation-error.js";
import {
  coerceIntLike,
  parseBool,
  parsePositiveInt,
  parseBoundedPositiveInt,
  parseNonNegativeInt,
  parseNonEmptyString,
} from "../config-primitives.js";
import { parseUrl } from "../config-values.js";
import { parseCustomLocalModels } from "../custom-models-schema.js";
import { isKnownLocalModelId, type LocalModelDef } from "../../local-llm/catalog/models-catalog.js";
import {
  BACKEND_VARIANT_PREFERENCES,
  isBackendVariantPreference,
  type BackendVariantPreference,
} from "../../local-llm/backend/windows-backend-variant.js";
import { MAX_DOWNLOAD_CONNECTIONS } from "../../local-llm/downloads/download-settings.js";
import { normalizeHuggingFaceEndpoint } from "../../local-llm/catalog/huggingface-endpoint.js";
import {
  isSwaFullPreference,
  SWA_FULL_PREFERENCES,
  type SwaFullPreference,
} from "../../local-llm/server/swa-full.js";

/** Pre-v41 `autoUpdate: false` was a dead default; force the live default. */
const MANAGED_AUTO_UPDATE_DEFAULTS_VERSION = 41;

/** The slot count that was the schema's default, never an operator's choice. */
const UNCHOSEN_PARALLEL = 2;

/** First version where `parallel` means "let the machine decide" by default. */
const AUTO_PARALLEL_VERSION = 63;

export function parseLocalTemplateSetting(
  raw: unknown,
  field: string,
): LocalTemplateSetting {
  if (raw === "auto" || raw === "on" || raw === "off") return raw;
  throw new ConfigValidationError(
    field,
    `expected auto|on|off, got ${JSON.stringify(raw)}`,
  );
}

export function parseLocalLlmMode(raw: unknown, field: string): LocalLlmMode {
  if (raw === "external" || raw === "managed") return raw;
  throw new ConfigValidationError(
    field,
    `expected external|managed, got ${JSON.stringify(raw)}`,
  );
}

export function parseBackendVariant(
  raw: unknown,
  field: string,
): BackendVariantPreference {
  if (isBackendVariantPreference(raw)) return raw;
  throw new ConfigValidationError(
    field,
    `expected ${BACKEND_VARIANT_PREFERENCES.join("|")}, got ${JSON.stringify(raw)}`,
  );
}

export function parseSwaFullPreference(
  raw: unknown,
  field: string,
): SwaFullPreference {
  if (isSwaFullPreference(raw)) return raw;
  throw new ConfigValidationError(
    field,
    `expected ${SWA_FULL_PREFERENCES.join("|")}, got ${JSON.stringify(raw)}`,
  );
}

/**
 * `localModels.completionMaxTokens` — the local runner's `n_predict`.
 *
 * `0` means **no client-side cap**: llama.cpp then generates until the
 * model emits a stop token or the context window fills. That is the
 * honest ceiling for a local run, and it is what an operator asking for
 * one long file wants. It costs wall-clock time, not memory — the
 * machine's exposure is fixed at daemon start by the model and
 * `--ctx-size`, not by how many tokens a single reply runs to — so the
 * only thing a cap buys locally is a bound on a runaway generation.
 * Anything else is the usual 64..131072 window.
 */
export function parseLocalCompletionCap(raw: unknown, field: string): number {
  const value = coerceIntLike(raw);
  if (value === 0) return 0;
  return parseBoundedPositiveInt(raw, field, 64, 131_072);
}

/**
 * `localModels.reasoningBudgetTokens` — the think-block bound of a local
 * reasoning model, in tokens. `0` means unbounded; anything else is an
 * integer in [64, 32768]. The upper bound keeps the grammar llama.cpp
 * expands server-side (`{0,N}` becomes N nested optional rules, four
 * per token) at a size it parses in milliseconds.
 */
export function parseReasoningBudgetTokens(
  raw: unknown,
  field: string,
): number {
  const value = coerceIntLike(raw);
  if (value === 0) return 0;
  return parseBoundedPositiveInt(raw, field, 64, 32_768);
}

/**
 * Parse `localModels.managed.tensorSplit` — the multi-GPU ratio list
 * forwarded to llama-server as `--tensor-split`. `[]` / absent means
 * "feature off" (single-device auto-pick). A non-empty list must name a
 * ratio per GPU: at least two finite non-negative numbers with at least
 * one positive (a lone ratio is not a split, and an all-zero list would
 * make llama-server offload nowhere). Zeros are allowed inside the list
 * to skip a device (e.g. `[1, 0, 1]` skips the middle GPU).
 */
export function parseTensorSplit(raw: unknown, field: string): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected number[], got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.length === 0) return [];
  if (raw.length === 1) {
    throw new ConfigValidationError(
      field,
      "expected at least two ratios (one per GPU) — a single ratio is not a split; use [] to disable",
    );
  }
  const result: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected finite non-negative number, got ${JSON.stringify(entry)}`,
      );
    }
    result.push(entry);
  }
  if (!result.some((r) => r > 0)) {
    throw new ConfigValidationError(
      field,
      "expected at least one positive ratio",
    );
  }
  return result;
}

function parseOptionalManagedModelId(
  raw: unknown,
  field: string,
  customModels: readonly LocalModelDef[],
): string | null {
  if (raw === null || raw === undefined) return null;
  const s = parseNonEmptyString(raw, field);
  // The added models come out of the same file, so they are checked
  // against that array rather than the module registry: a config that
  // adds a model and selects it in one write has to validate before
  // anything has had the chance to publish it.
  if (!isKnownLocalModelId(s) && !customModels.some((m) => m.id === s)) {
    throw new ConfigValidationError(
      field,
      `unknown managed local model id: ${JSON.stringify(s)}`,
    );
  }
  return s;
}

/**
 * `"auto"` (the machine decides, from the launch context) or a pinned
 * 1..8.
 *
 * The migration is the interesting half. A pre-v63 file carries a
 * `parallel` written by the schema, not by the operator — every file has
 * one, and for almost all of them it is the old default `2`. Reading
 * that as a deliberate pin would freeze every existing install at two
 * workers forever, which is exactly the setting this version exists to
 * stop asking about. So the old default becomes `"auto"`, and any other
 * number is treated as something someone actually chose and kept.
 */
function resolveManagedParallel(
  inputVersion: number,
  raw: unknown,
  readDefaults: () => UserLocalModelsConfig,
): number | "auto" {
  if (raw === "auto") return "auto";
  if (raw === null || raw === undefined) {
    return readDefaults().managed.parallel;
  }
  const pinned = parseBoundedPositiveInt(
    raw,
    "localModels.managed.parallel",
    1,
    8,
  );
  if (inputVersion < AUTO_PARALLEL_VERSION && pinned === UNCHOSEN_PARALLEL) {
    return "auto";
  }
  return pinned;
}

function resolveManagedAutoUpdate(
  inputVersion: number,
  raw: unknown,
  readDefaults: () => UserLocalModelsConfig,
): boolean {
  if (inputVersion < MANAGED_AUTO_UPDATE_DEFAULTS_VERSION) {
    return true;
  }
  return parseBool(
    raw ?? readDefaults().managed.autoUpdate,
    "localModels.managed.autoUpdate",
  );
}

function resolveEmbeddingModelId(
  _inputVersion: number,
  raw: unknown,
  readDefaults: () => UserLocalModelsConfig,
): string | null {
  if (raw !== null && raw !== undefined) {
    return parseNonEmptyString(raw, "localModels.embeddings.modelId");
  }
  return readDefaults().embeddings.modelId;
}

function parseHfEndpoint(value: unknown, path: string): string {
  const normalized =
    typeof value === "string" ? normalizeHuggingFaceEndpoint(value) : null;
  if (!normalized) {
    throw new ConfigValidationError(
      path,
      `must be an http(s) origin such as "https://hf-mirror.com", got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

export interface PreparedLocalModelsInputs {
  raw: Record<string, unknown>;
  customModels: LocalModelDef[];
  managed: UserManagedLocalLlmConfig;
  embeddings: UserManagedEmbeddingLlmConfig;
  download: LocalModelDownloadConfig;
  mode: LocalLlmMode;
  url: string;
}

export function prepareLocalModelsInputs(
  localModels: Record<string, unknown>,
  inputVersion: number,
  readDefaults: () => UserLocalModelsConfig,
): PreparedLocalModelsInputs {
  // Parsed before `managed.modelId` so a file that adds a model and
  // activates it in one write validates.
  const customModels = parseCustomLocalModels(
    localModels.customModels,
    "localModels.customModels",
  );

  const rawManaged =
    (localModels.managed as Record<string, unknown> | undefined) ?? {};
  if (rawManaged.engine !== undefined && rawManaged.engine !== "llama-server" && rawManaged.engine !== "atomic-core") {
    throw new ConfigValidationError("localModels.managed.engine", "expected llama-server|atomic-core");
  }
  const managed: UserManagedLocalLlmConfig = {
    engine: rawManaged.engine ?? "llama-server",
    modelId: parseOptionalManagedModelId(
      rawManaged.modelId,
      "localModels.managed.modelId",
      customModels,
    ),
    port: parsePositiveInt(
      rawManaged.port ?? readDefaults().managed.port,
      "localModels.managed.port",
    ),
    dataDirOverride:
      rawManaged.dataDirOverride === null ||
      rawManaged.dataDirOverride === undefined
        ? null
        : parseNonEmptyString(
            rawManaged.dataDirOverride,
            "localModels.managed.dataDirOverride",
          ),
    autoUpdate: resolveManagedAutoUpdate(inputVersion, rawManaged.autoUpdate, readDefaults),
    stopOnExit: parseBool(
      rawManaged.stopOnExit ??
        readDefaults().managed.stopOnExit,
      "localModels.managed.stopOnExit",
    ),
    autoRestart: parseBool(
      rawManaged.autoRestart ??
        readDefaults().managed.autoRestart,
      "localModels.managed.autoRestart",
    ),
    device: parseNonEmptyString(
      rawManaged.device ?? readDefaults().managed.device,
      "localModels.managed.device",
    ),
    backendVariant: parseBackendVariant(
      rawManaged.backendVariant ??
        readDefaults().managed.backendVariant,
      "localModels.managed.backendVariant",
    ),
    contextSize: parseNonNegativeInt(
      rawManaged.contextSize ??
        readDefaults().managed.contextSize,
      "localModels.managed.contextSize",
    ),
    tensorSplit: parseTensorSplit(
      rawManaged.tensorSplit,
      "localModels.managed.tensorSplit",
    ),
    parallel: resolveManagedParallel(inputVersion, rawManaged.parallel, readDefaults),
    swaFull: parseSwaFullPreference(
      rawManaged.swaFull ?? readDefaults().managed.swaFull,
      "localModels.managed.swaFull",
    ),
  };

  const rawEmbeddings =
    (localModels.embeddings as Record<string, unknown> | undefined) ?? {};
  const embeddingsPort = parsePositiveInt(
    rawEmbeddings.port ?? readDefaults().embeddings.port,
    "localModels.embeddings.port",
  );
  const embeddingsDaemon: UserManagedEmbeddingLlmConfig = {
    enabled: parseBool(
      rawEmbeddings.enabled ??
        readDefaults().embeddings.enabled,
      "localModels.embeddings.enabled",
    ),
    modelId: resolveEmbeddingModelId(inputVersion, rawEmbeddings.modelId, readDefaults),
    port: embeddingsPort,
    url: parseUrl(
      rawEmbeddings.url ?? `http://127.0.0.1:${embeddingsPort}`,
      "localModels.embeddings.url",
    ),
  };

  const rawDownload =
    (localModels.download as Record<string, unknown> | undefined) ?? {};
  const download: LocalModelDownloadConfig = {
    connections: parseBoundedPositiveInt(
      rawDownload.connections ??
        readDefaults().download.connections,
      "localModels.download.connections",
      1,
      MAX_DOWNLOAD_CONNECTIONS,
    ),
    hfEndpoint: parseHfEndpoint(
      rawDownload.hfEndpoint ??
        readDefaults().download.hfEndpoint,
      "localModels.download.hfEndpoint",
    ),
  };

  const localModelsMode = parseLocalLlmMode(
    localModels.mode ?? readDefaults().mode,
    "localModels.mode",
  );
  const localModelsUrl = parseUrl(
    localModels.url ?? readDefaults().url,
    "localModels.url",
  );
  return {
    raw: localModels,
    customModels,
    managed,
    embeddings: embeddingsDaemon,
    download,
    mode: localModelsMode,
    url: localModelsUrl,
  };
}

export function parseUserLocalModelsConfig(
  prepared: PreparedLocalModelsInputs,
  readDefaults: () => UserLocalModelsConfig,
): UserLocalModelsConfig {
  const {
    raw: localModels,
    customModels,
    managed,
    embeddings: embeddingsDaemon,
    download,
    mode: localModelsMode,
    url: localModelsUrl,
  } = prepared;
  return {
    url: localModelsUrl,
    mode: localModelsMode,
    completionMaxTokens: parseLocalCompletionCap(
      localModels.completionMaxTokens ??
        readDefaults().completionMaxTokens,
      "localModels.completionMaxTokens",
    ),
    useServerTemplate: parseLocalTemplateSetting(
      localModels.useServerTemplate ??
        readDefaults().useServerTemplate,
      "localModels.useServerTemplate",
    ),
    thinking: parseLocalTemplateSetting(
      localModels.thinking ?? readDefaults().thinking,
      "localModels.thinking",
    ),
    reasoningBudgetTokens: parseReasoningBudgetTokens(
      localModels.reasoningBudgetTokens ??
        readDefaults().reasoningBudgetTokens,
      "localModels.reasoningBudgetTokens",
    ),
    managed,
    embeddings: embeddingsDaemon,
    download,
    customModels,
  };
}
