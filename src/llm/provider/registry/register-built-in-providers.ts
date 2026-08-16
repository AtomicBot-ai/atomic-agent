import { getConfig } from "../../../config/index.js";
import { LlamaServerClient } from "../../llama-server-client.js";
import { AimlapiProvider } from "../aimlapi/aimlapi-provider.js";
import { AIMLAPI_DEFAULT_CHAT_MODEL } from "../aimlapi/aimlapi-models-catalog.js";
import {
  GeminiProvider,
  GEMINI_DEFAULT_CHAT_MODEL,
} from "../gemini/gemini-provider.js";
import { LlamaServerProvider } from "../llama-server/llama-server-provider.js";
import { OpenAiProvider } from "../openai/openai-provider.js";
import {
  OpenRouterProvider,
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "../openrouter/openrouter-provider.js";
import { registerProviderKind } from "./provider-types.js";

let registered = false;

export function registerBuiltInProviderKinds(): void {
  if (registered) return;
  registered = true;

  registerProviderKind("llama-server", (ctx) => {
    const client = ctx.llamaClient ?? new LlamaServerClient();
    const getProfile =
      ctx.getProfile ??
      (() => {
        throw new Error("llama-server provider requires getProfile");
      });
    const config = getConfig();
    return new LlamaServerProvider(client, {
      id: ctx.entry.id,
      getProfile,
      visionEnabledByConfig: config.vision.enabled,
      visionAutoDetect: config.vision.autoDetect,
      maxImageBytes: config.vision.maxImageBytes,
      maxImagesPerCall: config.vision.maxImagesPerCall,
      baseUrlOverride: ctx.entry.url,
    });
  });

  registerProviderKind("openai-compatible", (ctx) => {
    const entry = ctx.entry;
    if (!entry.baseUrl || !entry.defaultChatModel) {
      throw new Error(
        `openai-compatible provider "${entry.id}" requires baseUrl and defaultChatModel`,
      );
    }
    return new OpenAiProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      defaultChatModel: entry.defaultChatModel,
      headers: entry.headers,
      supportsVision: entry.supportsVision ?? true,
      supportsParallelTools: entry.supportsTools ?? true,
      requestTimeoutMs: entry.requestTimeoutMs,
    });
  });

  registerProviderKind("qwen-openai-compatible", (ctx) => {
    const entry = ctx.entry;
    if (!entry.baseUrl || !entry.defaultChatModel) {
      throw new Error(
        `qwen-openai-compatible provider "${entry.id}" requires baseUrl and defaultChatModel`,
      );
    }
    return new OpenAiProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      defaultChatModel: entry.defaultChatModel,
      headers: entry.headers,
      supportsVision: entry.supportsVision ?? true,
      supportsParallelTools: entry.supportsTools ?? true,
      requestTimeoutMs: entry.requestTimeoutMs,
      taggedToolCompatibility: "qwen",
    });
  });

  registerProviderKind("openrouter", (ctx) => {
    const entry = ctx.entry;
    return new OpenRouterProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      defaultChatModel: entry.defaultChatModel ?? "openrouter/auto",
      headers: entry.headers,
      supportsVision: entry.supportsVision ?? true,
      supportsParallelTools: entry.supportsTools ?? true,
      requestTimeoutMs: entry.requestTimeoutMs,
      httpReferer: OPENROUTER_APP_REFERER,
      xTitle: OPENROUTER_APP_TITLE,
      categories: OPENROUTER_APP_CATEGORIES,
    });
  });

  registerProviderKind("aimlapi", (ctx) => {
    const entry = ctx.entry;
    return new AimlapiProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      defaultChatModel: entry.defaultChatModel ?? AIMLAPI_DEFAULT_CHAT_MODEL,
      headers: entry.headers,
      supportsVision: entry.supportsVision ?? true,
      supportsParallelTools: entry.supportsTools ?? true,
      requestTimeoutMs: entry.requestTimeoutMs,
    });
  });

  registerProviderKind("gemini", (ctx) => {
    const entry = ctx.entry;
    return new GeminiProvider({
      id: entry.id,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      defaultChatModel: entry.defaultChatModel ?? GEMINI_DEFAULT_CHAT_MODEL,
      headers: entry.headers,
      supportsVision: entry.supportsVision ?? true,
      supportsParallelTools: entry.supportsTools ?? true,
      requestTimeoutMs: entry.requestTimeoutMs,
    });
  });

  registerProviderKind("sarvam", (ctx) => {
      const entry = ctx.entry;
      if (!entry.baseUrl || !entry.defaultChatModel) {
        throw new Error(
          `sarvam provider "${entry.id}" requires baseUrl and defaultChatModel`,
        );
      }
      return new OpenAiProvider({
        id: entry.id,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey ?? "",
        defaultChatModel: entry.defaultChatModel,
        headers: entry.headers,
        supportsVision: entry.supportsVision ?? false,
        supportsParallelTools: entry.supportsTools ?? true,
        requestTimeoutMs: entry.requestTimeoutMs,
      });
    });
  }
