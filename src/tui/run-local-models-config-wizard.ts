import { render } from "ink";
import React from "react";
import { getConfig, USER_CONFIG_DEFAULTS } from "../config/index.js";
import type { UserLlmProviderEntry } from "../config/llm-config.js";
import { usesExternalCliAuth } from "../config/provider-auth-mode.js";
import { resolveLlmProviderApiKey } from "../config/resolve-llm-api-key.js";
import {
  getLocalModelDef,
  isBackendDownloaded,
  isKnownLocalModelId,
  isModelDownloaded,
} from "../local-llm/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import {
  LocalModelsConfigWizard,
  type LocalModelsWizardOutcome,
} from "./components/local-models-config-wizard.js";
import { presetForEntryId } from "./providers/provider-presets.js";

export type LocalModelsStartupGateResult =
  | "ok"
  | "aborted"
  | "saved_managed"
  | "saved_cloud";

/**
 * When llama-server is down at TUI startup, run a small Ink wizard so the
 * user can fix `llama.url` in config without leaving the terminal. Skipped
 * entirely when `ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP=1` or when health already
 * passes.
 *
 * The wizard only reports what the user chose — it never imposes a UI mode
 * on the main TUI. The main TUI always lands in chat mode with the splash
 * banner; managed-mode users see daemon health in the footer indicator and
 * can open the Models tab explicitly with `/models` when they need it.
 *
 * Managed mode fast-path: if the user already picked a model and both the
 * backend binary and GGUF file are on disk, we skip the wizard entirely
 * even when the daemon is currently down — `autoStartIfReady()` will spin
 * it up in the background while the user lands directly in the chat view.
 * External mode (URL) intentionally never triggers an auto-start; if the
 * configured URL is unreachable we still surface the wizard so the user
 * can fix it.
 */
export async function runLocalModelsStartupGateIfNeeded(options: {
  skipWizard: boolean;
}): Promise<LocalModelsStartupGateResult> {
  if (options.skipWizard) return "ok";
  if (isCloudTextProviderReady()) return "ok";
  const probe = await checkLlamaServer({ retries: 0, backoffMs: 0 });
  if (probe.reachable) return "ok";
  if (isManagedModeReadyOnDisk()) return "ok";

  process.stderr.write(
    `[atomic-agent] local-llm unreachable at ${getConfig().localModels.url} — starting setup…\n`,
  );

  const outcome = { value: "skipped" as LocalModelsWizardOutcome };
  const ink = render(
    React.createElement(LocalModelsConfigWizard, {
      initialUrl: getConfig().localModels.url,
      probeError: probe.error,
      hadConfiguredBackend: isLocalBackendConfigured(),
      onFinished: (o) => {
        outcome.value = o;
      },
    }),
    { stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false },
  );
  await ink.waitUntilExit();
  ink.clear();

  if (outcome.value === "aborted") return "aborted";
  if (outcome.value === "saved_managed") return "saved_managed";
  if (outcome.value === "saved_cloud") return "saved_cloud";
  return "ok";
}

export function isCloudTextProviderReady(): boolean {
  const cfg = getConfig();
  const active = cfg.llm?.activeTextProvider;
  if (!active || active === "local-llama") return false;
  const entry = cfg.llm?.providers.find((provider) => provider.id === active);
  if (!entry) return false;
  if (resolveLlmProviderApiKey(entry)) return true;
  if (isKeylessLocalProviderEntry(entry)) return true;
  // A subscription CLI carries no key and no base URL, so both checks
  // above miss it. Reachable only for a kind that config validation
  // rejected outright before this existed, so no pre-existing config
  // changes behaviour here.
  return usesExternalCliAuth(entry);
}

/**
 * Local servers (Ollama, LM Studio) have no API key at all, so a missing
 * key must not send the user back into the startup wizard: a configured
 * local provider is as ready as a cloud one with a key. An entry counts
 * as keyless-local when its id maps to a `local: true` preset, or when
 * its base URL points at the operator's own machine — the latter covers
 * manual openai-compatible entries typed in before the preset existed.
 */
function isKeylessLocalProviderEntry(entry: UserLlmProviderEntry): boolean {
  if (presetForEntryId(entry.id)?.local) return true;
  if (!entry.baseUrl) return false;
  let host: string;
  try {
    host = new URL(entry.baseUrl).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
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
