import { getConfig, USER_CONFIG_DEFAULTS } from "../config/index.js";
import {
  getLocalModelDef,
  isBackendDownloaded,
  isKnownLocalModelId,
  isModelDownloaded,
} from "../local-llm/index.js";
import { providerKeyStatus } from "../llm/provider/provider-key.js";

/**
 * "Does this install have a backend at all?" — three predicates, no UI
 * and no network.
 *
 * They used to live next to the startup-gate wizard that consumed them.
 * The gate is gone (the first-run flow is a screen inside the app now),
 * but the questions outlived it: the flow asks them to decide whether to
 * open at all, and `tui-command` asks one of them for its diagnostics
 * line. A probe deliberately has no place here — a configured backend
 * that happens to be down is a health problem, not an unconfigured one.
 */
export function isCloudTextProviderReady(): boolean {
  const cfg = getConfig();
  const active = cfg.llm?.activeTextProvider;
  if (!active || active === "local-llama") return false;
  const entry = cfg.llm?.providers.find((provider) => provider.id === active);
  if (!entry) return false;
  // Ready when the key rule every other caller reads says the entry can
  // authenticate: a key resolves (or a credential header is set), it signs
  // in through a vendor CLI, or it is a local server with no key at all
  // (an Ollama or LM Studio entry must not send the user back into the
  // first-run flow). An entry that may or may not need a key does not
  // count: nothing says it can serve.
  const { state } = providerKeyStatus(entry);
  return state === "present" || state === "not-needed";
}

/**
 * Whether a local backend that could actually be serving was ever set up,
 * as opposed to untouched defaults. Two signals count: a selected managed
 * model, and an external URL the user typed instead of the shipped one.
 * Everything else a fresh install carries — `llm.activeTextProvider`
 * resolving to `local-llama`, the default `http://127.0.0.1:8080`, the
 * embeddings daemon toggle, which drives a different port and says nothing
 * about the chat server — is a default nobody chose and must not count, or
 * the first-run screen goes back to blaming the user for a server they
 * never asked for.
 *
 * Managed mode on its own deliberately does not count. Picking "Local
 * models" in the wizard writes `mode: "managed"` before any weights are
 * pulled, and no server can exist until they are, so treating the bare
 * mode as configured would report a multi-gigabyte download that has not
 * started yet as an unreachable server.
 */
export function isLocalBackendConfigured(): boolean {
  const cfg = getConfig();
  if (cfg.localModels.managed.modelId !== null) return true;
  // In managed mode the runtime derives `localModels.url` from
  // `managed.port`, so the comparison below only means anything when the
  // operator is on the external path.
  if (cfg.localModels.mode !== "external") return false;
  return cfg.localModels.url !== USER_CONFIG_DEFAULTS.localModels.url;
}

/**
 * Managed-mode readiness check for the startup fast-path: config is in
 * managed mode, a known model id is selected, and both the backend and
 * the GGUF file already live on disk. Returns `false` for external mode
 * so a misconfigured URL still surfaces the wizard. Exported so
 * `tui-command` can decide whether to land the user on the Models tab
 * after a `saved_managed` wizard outcome: managed + nothing on disk
 * means the user still has to pick + pull a model before chatting.
 */
export function isManagedModeReadyOnDisk(): boolean {
  const cfg = getConfig();
  if (cfg.localModels.mode !== "managed") return false;
  const modelId = cfg.localModels.managed.modelId;
  if (!modelId || !isKnownLocalModelId(modelId)) return false;
  const dataDir = cfg.paths.localModelsDataDir;
  if (!isBackendDownloaded(dataDir)) return false;
  const def = getLocalModelDef(modelId);
  if (!isModelDownloaded(dataDir, def)) return false;
  return true;
}
