import type { UserLocalModelsConfig } from "./local-models-types.js";
import { DEFAULT_DOWNLOAD_CONNECTIONS } from "../../local-llm/downloads/download-settings.js";
import { DEFAULT_HF_ENDPOINT } from "../../local-llm/catalog/huggingface-endpoint.js";

/**
 * Where an External llama.cpp is looked for when `localModels.url` is not
 * set. llama-server's own default port moved from 8080 to 9931 in
 * llama.cpp v0.7.0 (ggml-org/llama.cpp#30159); the official Docker images
 * still listen on 8080 inside the container.
 */
export const DEFAULT_EXTERNAL_LLAMA_URL = "http://127.0.0.1:9931";

/**
 * The shipped default before llama.cpp moved. Every first run writes the
 * defaults to `config.json`, so untouched installs still carry it.
 */
export const LEGACY_EXTERNAL_LLAMA_URL = "http://127.0.0.1:8080";

export function createLocalModelsDefaults(): UserLocalModelsConfig {
  return {
    url: DEFAULT_EXTERNAL_LLAMA_URL,
    mode: "external",
    completionMaxTokens: 16384,
    useServerTemplate: "auto",
    thinking: "auto",
    reasoningBudgetTokens: 0,
    drySampler: false,
    managed: {
      engine: "atomic-core",
      modelId: null,
      port: 19091,
      dataDirOverride: null,
      autoUpdate: true,
      stopOnExit: true,
      autoRestart: true,
      device: "auto",
      backendVariant: "auto",
      contextSize: 0,
      tensorSplit: [],
      parallel: "auto",
      swaFull: "auto",
    },
    embeddings: {
      enabled: false,
      modelId: null,
      port: 19092,
      url: "http://127.0.0.1:19092",
    },
    download: {
      connections: DEFAULT_DOWNLOAD_CONNECTIONS,
      hfEndpoint: DEFAULT_HF_ENDPOINT,
    },
    customModels: [],
  };
}
