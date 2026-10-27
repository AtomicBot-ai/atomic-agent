import { createServer } from "node:net";
import { totalmem } from "node:os";

import type { AtomicAgentConfig } from "../config/index.js";
import { resolveLlmProviderApiKey } from "../config/resolve-llm-api-key.js";
import type { UserLlmProviderEntry } from "../config/llm-config.js";
import { DEFAULT_AIMLAPI_BASE } from "../llm/provider/aimlapi/aimlapi-provider.js";
import { DEFAULT_GEMINI_BASE, GEMINI_API_PATH_PREFIX } from "../llm/provider/gemini/gemini-provider.js";
import { normalizeOpenAiBaseUrl } from "../llm/provider/openai/normalize-openai-base-url.js";
import { openAiChatPathPrefix } from "../llm/provider/openai/openai-chat-path.js";
import { DEFAULT_OPENROUTER_BASE } from "../llm/provider/openrouter/openrouter-provider.js";
import {
  pickProbeModels,
  verifyProviderKey,
  type ProviderVerifyKind,
  type ProviderVerifyResult,
  type ProviderVerifyTarget,
} from "../llm/provider/verify/index.js";
import {
  getDaemonStatus,
  getLocalModelDef,
  isBackendDownloaded,
  isKnownLocalModelId,
  isModelDownloaded,
  type DaemonStatus,
} from "../local-llm/index.js";
import type { DoctorFinding } from "./doctor-checks.js";

/**
 * ATO-577, second step: the local engine and the cloud key, read from the
 * loaded config. These only run once config.json is valid (doctor-checks'
 * `config` check is ok). None of them offers a fix: each says the one
 * command that repairs it. The key check sends one real completion of one
 * token (verifyProviderKey), the only answer that proves a key works.
 */
export interface EngineProbes {
  daemonStatus: (dataDir: string, port: number) => Promise<DaemonStatus>;
  backendInstalled: (dataDir: string, engine: AtomicAgentConfig["localModels"]["managed"]["engine"]) => boolean;
  modelDownloaded: (dataDir: string, modelId: string) => boolean | null;
  minRamGb: (modelId: string) => number | null;
  totalRamGb: () => number;
  portFree: (port: number) => Promise<boolean>;
  reachable: (url: string) => Promise<boolean>;
  verifyKey: (target: ProviderVerifyTarget) => Promise<ProviderVerifyResult>;
}

export const REAL_ENGINE_PROBES: EngineProbes = {
  daemonStatus: (dir, port) => getDaemonStatus(dir, port),
  backendInstalled: (dir, engine) => isBackendDownloaded(dir, engine),
  modelDownloaded: (dir, id) => (isKnownLocalModelId(id) ? isModelDownloaded(dir, getLocalModelDef(id)) : null),
  minRamGb: (id) => (isKnownLocalModelId(id) ? getLocalModelDef(id).minRamGb : null),
  totalRamGb: () => totalmem() / 1024 ** 3,
  portFree: (port) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    }),
  reachable: async (url) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return true;
    } catch {
      return false;
    }
  },
  verifyKey: (target) => verifyProviderKey(target),
};

function activeProvider(cfg: AtomicAgentConfig): UserLlmProviderEntry | null {
  const llm = cfg.llm;
  if (!llm) return null;
  return (llm.providers.find((p) => p.id === llm.activeTextProvider) as UserLlmProviderEntry | undefined) ?? null;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** What to send the key check for a saved provider, or null when there is no key or nothing to ask. */
export function verifyTargetForEntry(entry: UserLlmProviderEntry): ProviderVerifyTarget | null {
  const apiKey = resolveLlmProviderApiKey(entry)?.trim();
  if (!apiKey) return null;
  let kind: ProviderVerifyKind;
  let baseUrl: string;
  let apiPathPrefix: string;
  if (entry.kind === "openrouter") [kind, baseUrl, apiPathPrefix] = ["openrouter", DEFAULT_OPENROUTER_BASE, "/v1"];
  else if (entry.kind === "aimlapi") [kind, baseUrl, apiPathPrefix] = ["aimlapi", DEFAULT_AIMLAPI_BASE, "/v1"];
  else if (entry.kind === "gemini") [kind, baseUrl, apiPathPrefix] = ["gemini", DEFAULT_GEMINI_BASE, GEMINI_API_PATH_PREFIX];
  else if (entry.kind === "openai-compatible" && entry.baseUrl) {
    baseUrl = normalizeOpenAiBaseUrl(entry.baseUrl);
    [kind, apiPathPrefix] = ["openai-compatible", openAiChatPathPrefix(baseUrl)];
  } else return null;
  if (isLoopback(baseUrl)) return null;
  return {
    label: entry.id,
    baseUrl,
    apiPathPrefix,
    apiKey,
    probeModels: pickProbeModels({ kind, selectedModelId: entry.defaultChatModel ?? entry.model ?? null }),
    ...(entry.headers ? { extraHeaders: entry.headers } : {}),
  };
}

async function checkLocalEngine(cfg: AtomicAgentConfig, probes: EngineProbes): Promise<DoctorFinding[]> {
  const lm = cfg.localModels;
  if (lm.mode === "external") {
    const ok = await probes.reachable(`${lm.url.replace(/\/+$/, "")}/health`);
    return [{ check: "engine", status: ok ? "ok" : "fail", message: ok ? `your model server at ${lm.url} answers` : `nothing answers at ${lm.url}; start your model server or change localModels.url` }];
  }
  const out: DoctorFinding[] = [];
  const dir = cfg.paths.localModelsDataDir;
  const installed = probes.backendInstalled(dir, lm.managed.engine);
  out.push(installed
    ? { check: "engine", status: "ok", message: "the local engine is installed" }
    : { check: "engine", status: "fail", message: "the local engine is not installed; run `atag models update`" });
  const id = lm.managed.modelId;
  if (!id) {
    out.push({ check: "model", status: "warn", message: "no local model chosen; `atag models list`, then `atag models use <id>`" });
  } else {
    const have = probes.modelDownloaded(dir, id);
    if (have === false) out.push({ check: "model", status: "fail", message: `${id} is not downloaded; run \`atag models pull ${id}\`` });
    else out.push({ check: "model", status: "ok", message: `${id} is on disk` });
    const need = probes.minRamGb(id);
    const total = probes.totalRamGb();
    if (need !== null && total < need) {
      out.push({ check: "memory", status: "warn", message: `${id} needs about ${need} GB of memory, this computer has ${total.toFixed(0)} GB; pick a smaller model` });
    } else if (need !== null) {
      out.push({ check: "memory", status: "ok", message: `${total.toFixed(0)} GB of memory, ${id} needs about ${need} GB` });
    }
  }
  const st = await probes.daemonStatus(dir, lm.managed.port);
  if (st.authMismatch) {
    out.push({ check: "server", status: "fail", message: `a model server on port ${st.port} rejects this agent's key; run \`atag models stop\`, then \`atag models start\`` });
  } else if (st.running) {
    out.push({ check: "server", status: "ok", message: `model server ${st.healthy ? "running" : st.loading ? "loading" : "started, not answering yet"} on port ${st.port}` });
  } else if (!(await probes.portFree(lm.managed.port))) {
    out.push({ check: "server", status: "fail", message: `port ${lm.managed.port} is taken by another program, so the model server cannot start; close it or change localModels.managed.port` });
  } else {
    out.push({ check: "server", status: "ok", message: `model server stopped; port ${lm.managed.port} is free and it starts with the agent` });
  }
  return out;
}

async function checkCloudKey(entry: UserLlmProviderEntry, probes: EngineProbes): Promise<DoctorFinding[]> {
  const target = verifyTargetForEntry(entry);
  if (!target) return [{ check: "key", status: "warn", message: `${entry.id}: no API key found in config.json or the environment` }];
  const r = await probes.verifyKey(target);
  const who = `${entry.id}`;
  switch (r.status) {
    case "ok": return [{ check: "key", status: "ok", message: `${who} accepted the key${r.probedModel ? ` (tested with ${r.probedModel})` : ""}` }];
    case "rate_limited": return [{ check: "key", status: "ok", message: `${who} is rate-limiting the key right now; the key itself works` }];
    case "invalid_key": return [{ check: "key", status: "fail", message: `${who} rejected the key${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}; paste a new one in the provider settings` }];
    case "no_balance": return [{ check: "key", status: "fail", message: `${who} accepted the key but the account has no balance; top it up` }];
    default: return [{ check: "key", status: "warn", message: `${who}: the key could not be tested (${r.status}${r.detail ? `: ${r.detail}` : ""})` }];
  }
}

export async function runEngineChecks(cfg: AtomicAgentConfig, probes: EngineProbes = REAL_ENGINE_PROBES): Promise<DoctorFinding[]> {
  const active = activeProvider(cfg);
  // No registry, or the local entry: the chat runs on the local engine.
  if (!active || active.kind === "llama-server") return checkLocalEngine(cfg, probes);
  return checkCloudKey(active, probes);
}
